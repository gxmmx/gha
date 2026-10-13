import * as core from "@actions/core";
import * as github from "@actions/github";
import { createHash } from "node:crypto";
import { glob, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  attemptAssetName,
  parseAttempt,
  readAttemptRecord,
  serializeAttemptBody,
  type AssetManifest,
  type AttemptRecord,
  type StagedAsset,
} from "../prepare-release/attempt.js";
import type { GitHubClient } from "../github/operations.js";
import {
  createGitHubOperations,
  getRelease,
  listReleaseAssets,
  updateRelease,
  uploadReleaseAsset,
} from "../github/operations.js";

const checksumName = "SHA256SUMS";

function uploadBaseUrl(apiUrl: string): string | undefined {
  return apiUrl === "https://api.github.com" ? undefined : apiUrl;
}

interface LocalAsset extends StagedAsset {
  bytes: Buffer;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function lines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function resolveAssets(input: string): Promise<LocalAsset[]> {
  const cwd = process.cwd();
  const root = await realpath(cwd);
  const resolved: LocalAsset[] = [];
  for (const pattern of lines(input)) {
    if (
      path.isAbsolute(pattern) ||
      pattern.split(/[\\/]/).includes("..") ||
      pattern.startsWith("!")
    ) {
      throw new Error(`Asset pattern must be a relative path: ${pattern}`);
    }
    const matches: string[] = [];
    for await (const match of glob(pattern, { cwd })) matches.push(match);
    if (matches.length === 0) {
      throw new Error(`Asset pattern did not match any files: ${pattern}`);
    }
    let filesFound = 0;
    for (const match of matches) {
      const fullPath = path.resolve(cwd, match);
      const actualPath = await realpath(fullPath);
      if (actualPath !== root && !actualPath.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Asset path escapes the consumer checkout: ${pattern}`);
      }
      if (!(await lstat(actualPath)).isFile()) continue;
      filesFound += 1;
      const name = path.basename(match);
      if (name === checksumName) {
        throw new Error(`${checksumName} is reserved for generated checksums`);
      }
      const bytes = await readFile(actualPath);
      resolved.push({ name, size: bytes.length, sha256: sha256(bytes), bytes });
    }
    if (filesFound === 0) {
      throw new Error(`Asset pattern did not match any files: ${pattern}`);
    }
  }
  if (resolved.length === 0 && lines(input).length > 0) {
    throw new Error("Asset patterns matched no files");
  }
  const byName = new Map<string, LocalAsset>();
  for (const asset of resolved) {
    if (byName.has(asset.name)) {
      throw new Error(`Multiple supplied assets use the name ${asset.name}`);
    }
    byName.set(asset.name, asset);
  }
  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function manifestFor(assets: LocalAsset[]): AssetManifest {
  const checksumBytes = Buffer.from(
    assets.map((asset) => `${asset.sha256}  ${asset.name}\n`).join(""),
  );
  return {
    schema_version: 1,
    assets: assets.map(({ name, size, sha256: digest }) => ({
      name,
      size,
      sha256: digest,
    })),
    checksum_asset:
      assets.length === 0
        ? null
        : {
            name: checksumName,
            size: checksumBytes.length,
            sha256: sha256(checksumBytes),
          },
  };
}

function sameManifest(
  left: AssetManifest | undefined,
  right: AssetManifest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function digestOf(asset: { digest?: string | null }): string | null {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? "");
  return match?.[1]?.toLowerCase() ?? null;
}

async function putAsset(args: {
  octokit: GitHubClient;
  owner: string;
  repo: string;
  releaseId: number;
  name: string;
  bytes: Buffer;
  baseUrl?: string;
}): Promise<void> {
  const { octokit, owner, repo, releaseId, name, bytes, baseUrl } = args;
  await uploadReleaseAsset({
    octokit,
    owner,
    repo,
    release_id: releaseId,
    name,
    // Octokit's generated endpoint type says string, but upload payloads are raw bytes.
    data: bytes as unknown as string,
    ...(baseUrl ? { baseUrl } : {}),
    headers: { "content-type": "application/octet-stream" },
  });
}

async function stageReleaseAssets(args: {
  octokit: GitHubClient;
  owner: string;
  repo: string;
  releaseId: number;
  attemptId: string;
  assetsInput: string;
}): Promise<{ manifest: AssetManifest; names: string[] }> {
  const { octokit, owner, repo, releaseId, attemptId, assetsInput } = args;
  const localAssets = await resolveAssets(assetsInput);
  const desired = manifestFor(localAssets);
  const release = await getRelease({
    octokit,
    owner,
    repo,
    releaseId,
  });
  if (!release.data.draft) {
    throw new Error("Release assets can only be staged on a draft release");
  }
  const existingAssets = await listReleaseAssets({
    octokit,
    owner,
    repo,
    releaseId,
  });
  const record = await readAttemptRecord({
    octokit,
    owner,
    repo,
    release: { ...release.data, assets: existingAssets },
  });
  if (
    !record ||
    record.attempt_id !== attemptId ||
    record.tag !== release.data.tag_name
  ) {
    throw new Error("Draft release does not match the supplied attempt ID");
  }
  if (record.abandoned) {
    throw new Error(
      `Release attempt was abandoned: ${record.abandoned.reason}`,
    );
  }
  if (record.asset_manifest && !sameManifest(record.asset_manifest, desired)) {
    throw new Error(
      "Retry supplies different asset bytes for this release attempt",
    );
  }

  const expected = new Map<string, StagedAsset>();
  for (const asset of desired.assets) expected.set(asset.name, asset);
  if (desired.checksum_asset) {
    expected.set(desired.checksum_asset.name, desired.checksum_asset);
  }
  if (existingAssets.some((asset) => asset.name === attemptAssetName)) {
    const attemptBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    expected.set(attemptAssetName, {
      name: attemptAssetName,
      size: attemptBytes.length,
      sha256: sha256(attemptBytes),
    });
  }
  for (const existing of existingAssets) {
    const entry = expected.get(existing.name);
    if (!entry) {
      throw new Error(
        `Draft contains an asset not claimed by this attempt: ${existing.name}`,
      );
    }
    if (existing.size !== entry.size || digestOf(existing) !== entry.sha256) {
      throw new Error(`Staged asset ${existing.name} has different bytes`);
    }
    expected.delete(existing.name);
  }

  if (!record.asset_manifest) {
    const updated: AttemptRecord = { ...record, asset_manifest: desired };
    await updateRelease({
      octokit,
      owner,
      repo,
      release_id: releaseId,
      tag_name: record.tag,
      draft: true,
      body: serializeAttemptBody(release.data.body, updated),
    });
  }

  for (const asset of localAssets) {
    if (!expected.has(asset.name)) continue;
    await putAsset({
      octokit,
      owner,
      repo,
      releaseId,
      name: asset.name,
      bytes: asset.bytes,
      baseUrl: uploadBaseUrl(github.context.apiUrl),
    });
    expected.delete(asset.name);
  }
  if (desired.checksum_asset && expected.has(checksumName)) {
    const checksumBytes = Buffer.from(
      localAssets.map((asset) => `${asset.sha256}  ${asset.name}\n`).join(""),
    );
    await putAsset({
      octokit,
      owner,
      repo,
      releaseId,
      name: checksumName,
      bytes: checksumBytes,
      baseUrl: uploadBaseUrl(github.context.apiUrl),
    });
    expected.delete(checksumName);
  }
  if (expected.size > 0) {
    throw new Error(
      `Could not stage all release assets: ${[...expected.keys()].join(", ")}`,
    );
  }
  return {
    manifest: desired,
    names: [
      ...desired.assets.map((asset) => asset.name),
      ...(desired.checksum_asset ? [checksumName] : []),
    ],
  };
}

async function main(): Promise<void> {
  const { octokit, owner, repo } = createGitHubOperations(
    core.getInput("github_token", { required: true }),
  );
  const result = await stageReleaseAssets({
    octokit,
    owner,
    repo,
    releaseId: Number(core.getInput("draft_release_id", { required: true })),
    attemptId: core.getInput("attempt_id", { required: true }),
    assetsInput: core.getInput("assets"),
  });
  core.setOutput("staged", "true");
  core.setOutput("asset_names", JSON.stringify(result.names));
  core.setOutput("asset_manifest", JSON.stringify(result.manifest));
  core.setOutput("checksum_asset", result.manifest.checksum_asset?.name ?? "");
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
