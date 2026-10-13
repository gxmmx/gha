import * as core from "@actions/core";
import * as github from "@actions/github";
import { createHash } from "node:crypto";
import {
  attemptMarker,
  parseAttempt,
  serializeAttemptBody,
  type AttemptRecord,
  type RegistryReceipt,
  type ReleasePlan,
  type StagedAsset,
} from "../prepare-release/attempt.js";

const receiptAssetName = "release-receipt.json";
const receiptSectionMarker = "<!-- gxmmx-registry-receipt:v1 -->";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parsePlan(input: string): ReleasePlan {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("release_plan must be valid prepared-plan JSON");
  }
  if (!value || typeof value !== "object") {
    throw new Error("release_plan must be a prepared plan object");
  }
  return value as ReleasePlan;
}

function parseReceipt(input: string): RegistryReceipt | undefined {
  if (!input.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("registry_receipt must be valid JSON");
  }
  if (
    !value ||
    typeof value !== "object" ||
    (value as RegistryReceipt).schema_version !== 1 ||
    !Array.isArray((value as RegistryReceipt).artifacts) ||
    (value as RegistryReceipt).artifacts.length === 0
  ) {
    throw new Error(
      "registry_receipt must contain schema_version 1 and at least one artifact",
    );
  }
  const artifacts = (value as RegistryReceipt).artifacts;
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    if (
      !artifact ||
      typeof artifact.registry !== "string" ||
      !artifact.registry.trim() ||
      typeof artifact.reference !== "string" ||
      !/^\S+$/.test(artifact.reference) ||
      typeof artifact.digest !== "string" ||
      !/^(?:(?:sha256|sha384|sha512):[a-f0-9]{32,128}|sha(?:256|384|512)-[A-Za-z0-9+/=_-]+)$/i.test(
        artifact.digest,
      )
    ) {
      throw new Error(
        "Each registry receipt artifact needs a registry, reference, and immutable digest",
      );
    }
    const key = `${artifact.registry}\0${artifact.reference}`;
    if (seen.has(key)) {
      throw new Error(
        "registry_receipt contains a duplicate artifact reference",
      );
    }
    seen.add(key);
  }
  return value as RegistryReceipt;
}

function withoutReceiptSection(notes: string): string {
  return notes.split(receiptSectionMarker)[0].trim();
}

function notesWithReceipt(notes: string, receipt?: RegistryReceipt): string {
  const base = withoutReceiptSection(notes);
  if (!receipt) return base;
  const artifacts = receipt.artifacts
    .map((artifact) => {
      const reference = /^https?:\/\//i.test(artifact.reference)
        ? `[${artifact.registry}](${artifact.reference.replace(/[()\\]/g, "\\$&")})`
        : `\`${artifact.registry}: ${artifact.reference}\``;
      return `- ${reference} — \`${artifact.digest}\``;
    })
    .join("\n");
  const section = `${receiptSectionMarker}\n## Registry artifacts\n\n${artifacts}`;
  return base ? `${base}\n\n${section}` : section;
}

function samePlan(left: ReleasePlan, right: ReleasePlan): boolean {
  return (
    JSON.stringify({ ...left, attempt_id: undefined }) ===
    JSON.stringify({ ...right, attempt_id: undefined })
  );
}

function validatePlan(args: {
  plan: ReleasePlan;
  record: AttemptRecord;
  attemptId: string;
  owner: string;
  repo: string;
}): void {
  const { plan, record, attemptId, owner, repo } = args;
  if (
    plan.schema_version !== 1 ||
    plan.repository?.owner !== owner ||
    plan.repository?.name !== repo ||
    plan.source?.event !== "push" ||
    !/^[a-f0-9]{40}$/i.test(plan.source.sha ?? "") ||
    !plan.source.target_branch ||
    !plan.configuration ||
    plan.decision?.reason !== "release" ||
    plan.decision.release_required !== true ||
    !plan.versions?.next_release_tag ||
    !plan.versions.next_release_version
  ) {
    throw new Error("release_plan is not a valid prepared release plan");
  }
  if (record.abandoned) {
    throw new Error(
      `Release attempt was abandoned: ${record.abandoned.reason}`,
    );
  }
  if (
    plan.attempt_id !== attemptId ||
    record.attempt_id !== attemptId ||
    record.tag !== plan.versions.next_release_tag ||
    record.version !== plan.versions.next_release_version ||
    record.source_sha !== plan.source.sha ||
    !samePlan(record.plan, plan)
  ) {
    throw new Error(
      "Prepared release plan does not match the draft attempt source, version, or configuration",
    );
  }
}

function digestOf(asset: { digest?: string | null }): string | null {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? "");
  return match?.[1]?.toLowerCase() ?? null;
}

function assertAssetMatches(
  actual: { name: string; size: number; digest?: string | null },
  expected: StagedAsset,
): void {
  if (
    actual.size !== expected.size ||
    digestOf(actual) !== expected.sha256.toLowerCase()
  ) {
    throw new Error(`Release asset ${actual.name} does not match the attempt`);
  }
}

async function uploadReceipt(args: {
  octokit: ReturnType<typeof github.getOctokit>;
  owner: string;
  repo: string;
  releaseId: number;
  bytes: Buffer;
}): Promise<void> {
  const { octokit, owner, repo, releaseId, bytes } = args;
  await octokit.rest.repos.uploadReleaseAsset({
    owner,
    repo,
    release_id: releaseId,
    name: receiptAssetName,
    data: bytes as unknown as string,
    ...(github.context.apiUrl !== "https://api.github.com"
      ? { baseUrl: github.context.apiUrl }
      : {}),
    headers: { "content-type": "application/json" },
  });
}

async function publishRelease(args: {
  octokit: ReturnType<typeof github.getOctokit>;
  owner: string;
  repo: string;
  releaseId: number;
  attemptId: string;
  plan: ReleasePlan;
  receipt?: RegistryReceipt;
}): Promise<{
  version: string;
  tag: string;
  sourceSha: string;
  receiptName: string;
}> {
  const { octokit, owner, repo, releaseId, attemptId, plan, receipt } = args;
  const current = await octokit.rest.repos.getRelease({
    owner,
    repo,
    release_id: releaseId,
  });
  const release = current.data;
  if (release.tag_name !== plan.versions.next_release_tag) {
    throw new Error("Draft release tag does not match the prepared plan");
  }
  const record = parseAttempt(release.body);
  if (!record)
    throw new Error("Release is missing its prepared attempt record");
  validatePlan({ plan, record, attemptId, owner, repo });

  const tagRef = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `tags/${record.tag}`,
  });
  if (
    tagRef.data.object.type !== "commit" ||
    tagRef.data.object.sha !== record.source_sha
  ) {
    throw new Error(
      "Full-version tag does not point to the exact source commit",
    );
  }
  if (
    release.prerelease !== (plan.decision.channel !== "stable") ||
    (release.name &&
      release.name !== record.version &&
      release.name !== record.tag)
  ) {
    throw new Error("Draft release metadata does not match the prepared plan");
  }
  const persistedReceipt = record.registry_receipt;
  if (
    receipt &&
    persistedReceipt &&
    JSON.stringify(receipt) !== JSON.stringify(persistedReceipt)
  ) {
    throw new Error(
      "Retry supplied a different registry receipt for this attempt",
    );
  }

  const assets = await octokit.paginate(octokit.rest.repos.listReleaseAssets, {
    owner,
    repo,
    release_id: releaseId,
    per_page: 100,
  });
  const assetByName = new Map(assets.map((asset) => [asset.name, asset]));
  const claimedAssets = new Map<string, StagedAsset>();
  for (const asset of record.asset_manifest?.assets ?? []) {
    claimedAssets.set(asset.name, asset);
  }
  if (record.asset_manifest?.checksum_asset) {
    claimedAssets.set(
      record.asset_manifest.checksum_asset.name,
      record.asset_manifest.checksum_asset,
    );
  }
  for (const expected of claimedAssets.values()) {
    const actual = assetByName.get(expected.name);
    if (!actual)
      throw new Error(`Prepared release asset ${expected.name} is missing`);
    assertAssetMatches(actual, expected);
  }
  const receiptExpected = receipt ?? persistedReceipt;
  const allowedAssets = new Set(claimedAssets.keys());
  if (receiptExpected) allowedAssets.add(receiptAssetName);
  for (const asset of assets) {
    if (!allowedAssets.has(asset.name)) {
      throw new Error(
        `Release contains an asset not claimed by this attempt: ${asset.name}`,
      );
    }
  }
  if (release.draft === false) {
    if (receipt && !persistedReceipt) {
      throw new Error(
        "Published release has no matching stored registry receipt",
      );
    }
    if (persistedReceipt) {
      const expected = receiptAsset(persistedReceipt);
      const actual = assetByName.get(receiptAssetName);
      if (!actual)
        throw new Error("Published release is missing its registry receipt");
      assertAssetMatches(actual, expected);
    } else if (assetByName.has(receiptAssetName)) {
      throw new Error(
        "Published release contains an unrecorded registry receipt",
      );
    }
    return {
      version: record.version,
      tag: record.tag,
      sourceSha: record.source_sha,
      receiptName: persistedReceipt ? receiptAssetName : "",
    };
  }
  if (persistedReceipt && !receipt) {
    // A retry can publish the already-recorded receipt without resupplying it.
  }
  const finalReceipt = receiptExpected;
  const expectedReceipt = finalReceipt ? receiptAsset(finalReceipt) : undefined;
  const existingReceipt = assetByName.get(receiptAssetName);
  if (expectedReceipt) {
    if (existingReceipt) {
      assertAssetMatches(existingReceipt, expectedReceipt);
    } else {
      await uploadReceipt({
        octokit,
        owner,
        repo,
        releaseId,
        bytes: receiptBytes(finalReceipt!),
      });
    }
  } else if (existingReceipt) {
    throw new Error("Draft contains an unrecorded registry receipt asset");
  }

  const updatedRecord: AttemptRecord = {
    ...record,
    ...(finalReceipt ? { registry_receipt: finalReceipt } : {}),
  };
  const notes = notesWithReceipt(
    (release.body ?? "").split(attemptMarker)[0].trim(),
    finalReceipt,
  );
  const body = serializeAttemptBody(notes, updatedRecord);
  if (finalReceipt) {
    const saved = await octokit.rest.repos.updateRelease({
      owner,
      repo,
      release_id: releaseId,
      tag_name: record.tag,
      body,
      draft: true,
      prerelease: release.prerelease,
    });
    const savedRecord = parseAttempt(saved.data.body);
    if (
      !saved.data.draft ||
      !savedRecord ||
      JSON.stringify(savedRecord.registry_receipt) !==
        JSON.stringify(finalReceipt)
    ) {
      throw new Error("Registry receipt was not stored on the draft release");
    }
    const savedAssets = await octokit.paginate(
      octokit.rest.repos.listReleaseAssets,
      { owner, repo, release_id: releaseId, per_page: 100 },
    );
    const savedReceiptAsset = savedAssets.find(
      (asset) => asset.name === receiptAssetName,
    );
    if (!savedReceiptAsset) {
      throw new Error(
        "Registry receipt asset was not stored on the draft release",
      );
    }
    assertAssetMatches(savedReceiptAsset, expectedReceipt!);
  }

  const published = await octokit.rest.repos.updateRelease({
    owner,
    repo,
    release_id: releaseId,
    tag_name: record.tag,
    body,
    draft: false,
    prerelease: plan.decision.channel !== "stable",
  });
  if (published.data.draft) {
    throw new Error("GitHub did not publish the draft release");
  }
  const publishedRecord = parseAttempt(published.data.body);
  if (
    !publishedRecord ||
    publishedRecord.attempt_id !== attemptId ||
    publishedRecord.source_sha !== plan.source.sha ||
    (finalReceipt &&
      JSON.stringify(publishedRecord.registry_receipt) !==
        JSON.stringify(finalReceipt))
  ) {
    throw new Error("Published release does not retain the prepared attempt");
  }
  return {
    version: record.version,
    tag: record.tag,
    sourceSha: record.source_sha,
    receiptName: finalReceipt ? receiptAssetName : "",
  };
}

function receiptBytes(receipt: RegistryReceipt): Buffer {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
}

function receiptAsset(receipt: RegistryReceipt): StagedAsset {
  const bytes = receiptBytes(receipt);
  return {
    name: receiptAssetName,
    size: bytes.length,
    sha256: sha256(bytes),
  };
}

async function main(): Promise<void> {
  const context = github.context;
  const { owner, repo } = context.repo;
  const plan = parsePlan(core.getInput("release_plan", { required: true }));
  const receipt = parseReceipt(core.getInput("registry_receipt"));
  const result = await publishRelease({
    octokit: github.getOctokit(
      core.getInput("github_token", { required: true }),
      {
        baseUrl: context.apiUrl,
      },
    ),
    owner,
    repo,
    releaseId: Number(core.getInput("draft_release_id", { required: true })),
    attemptId: core.getInput("attempt_id", { required: true }),
    plan,
    receipt,
  });
  core.setOutput("published", "true");
  core.setOutput("release_id", String(core.getInput("draft_release_id")));
  core.setOutput("tag", result.tag);
  core.setOutput("version", result.version);
  core.setOutput("source_sha", result.sourceSha);
  core.setOutput("receipt_asset_name", result.receiptName);
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
