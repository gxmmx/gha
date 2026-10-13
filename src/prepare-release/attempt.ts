import { CommitParser } from "conventional-commits-parser";
import {
  createGitRef,
  createRelease,
  getReleaseAsset,
  getGitRef,
  listRepositoryReleases,
  type GitHubClient,
} from "../github/operations.js";

export interface ReleasePlan {
  schema_version: 1;
  repository: { owner: string; name: string };
  source: {
    event: string;
    run_id: number;
    sha: string;
    target_branch: string;
    pull_request: number | null;
  };
  configuration: {
    stable_branch: string;
    alpha_branch: string | null;
    beta_branch: string | null;
    rc_branch: string | null;
    version_format: "semver" | "pep440";
  };
  history: {
    stable_base_version: string | null;
    stable_release_tag: string | null;
    stable_release_sha: string | null;
  };
  decision: {
    channel: "stable" | "alpha" | "beta" | "rc";
    bump: "patch" | "minor" | "major";
    reason: "release";
    release_required: true;
  };
  versions: {
    build_version: string;
    next_stable_version: string;
    next_release_version: string;
    next_release_tag: string;
  };
  attempt_id?: string;
}

export interface StagedAsset {
  name: string;
  size: number;
  sha256: string;
}

export interface AssetManifest {
  schema_version: 1;
  assets: StagedAsset[];
  checksum_asset: StagedAsset | null;
}

export interface RegistryReceipt {
  schema_version: 1;
  artifacts: Array<{
    registry: string;
    reference: string;
    digest: string;
  }>;
}

export interface AttemptRecord {
  schema_version: 1;
  attempt_id: string;
  tag: string;
  version: string;
  source_sha: string;
  plan: ReleasePlan;
  asset_manifest?: AssetManifest;
  registry_receipt?: RegistryReceipt;
  major_alias_enabled?: boolean;
  abandoned?: { reason: string; at: string };
}

export const attemptMarker = "<!-- gxmmx-release-attempt:v1 -->";
export const attemptAssetName = "gxmmx-release-attempt.json";
const parser = new CommitParser();

function attemptId(tag: string, sha: string): string {
  return `${tag.replace(/[^A-Za-z0-9.-]/g, "-")}@${sha.slice(0, 12)}`;
}

export function parseAttempt(
  body: string | null | undefined,
): AttemptRecord | null {
  if (!body) return null;
  const start = body.indexOf(attemptMarker);
  if (start < 0) return null;
  const json = body
    .slice(start + attemptMarker.length)
    .trim()
    .split("\n")[0];
  try {
    const value = JSON.parse(json) as AttemptRecord;
    return value.schema_version === 1 && value.attempt_id ? value : null;
  } catch {
    return null;
  }
}

export function parseAttemptJson(value: string): AttemptRecord | null {
  try {
    const record = JSON.parse(value) as AttemptRecord;
    return record.schema_version === 1 && record.attempt_id ? record : null;
  } catch {
    return null;
  }
}

export async function readAttemptRecord(args: {
  octokit: GitHubClient;
  owner: string;
  repo: string;
  release: {
    id: number;
    body?: string | null;
    assets?: Array<{ id: number; name: string }>;
  };
}): Promise<AttemptRecord | null> {
  const { octokit, owner, repo, release } = args;
  const asset = release.assets?.find((item) => item.name === attemptAssetName);
  const bodyRecord = parseAttempt(release.body);
  if (release.body?.includes(attemptMarker) && !bodyRecord) {
    throw new Error("Release body contains an invalid attempt record");
  }
  if (!asset) return bodyRecord;

  const downloaded = await getReleaseAsset({
    octokit,
    owner,
    repo,
    assetId: asset.id,
  });
  const data = downloaded.data as unknown;
  const bytes =
    typeof data === "string"
      ? Buffer.from(data)
      : data instanceof ArrayBuffer
        ? Buffer.from(new Uint8Array(data))
        : Buffer.from(data as Uint8Array);
  const record = parseAttemptJson(bytes.toString("utf8"));
  if (!record) throw new Error(`Release asset ${attemptAssetName} is invalid`);
  if (bodyRecord && JSON.stringify(bodyRecord) !== JSON.stringify(record)) {
    throw new Error(
      `Release body and ${attemptAssetName} contain conflicting attempt data`,
    );
  }
  return record;
}

export function serializeAttemptBody(
  body: string | null | undefined,
  record: AttemptRecord,
): string {
  const notes = (body ?? "").split(attemptMarker)[0].trim();
  return `${notes}\n\n${attemptMarker}\n${JSON.stringify(record)}`;
}

function releaseNotes(messages: string[], prBody: string | null): string {
  const groups: Record<string, string[]> = {
    "Breaking changes": [],
    Features: [],
    Fixes: [],
  };
  const seen = new Set<string>();
  for (const message of messages) {
    for (const raw of message.split(/\r?\n/)) {
      const line = raw.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "");
      if (!line) continue;
      const parsed = parser.parse(line);
      if (!parsed.type || !parsed.subject) continue;
      const isBreaking = parsed.breaking === "!" || parsed.notes.length > 0;
      const group = isBreaking
        ? "Breaking changes"
        : parsed.type === "feat"
          ? "Features"
          : parsed.type === "fix"
            ? "Fixes"
            : null;
      if (!group || seen.has(line)) continue;
      seen.add(line);
      groups[group].push(`- ${parsed.subject}`);
    }
  }
  const sections = Object.entries(groups)
    .filter(([, lines]) => lines.length > 0)
    .map(([heading, lines]) => `## ${heading}\n\n${lines.join("\n")}`);
  const extra = extractReleaseNotes(prBody);
  if (extra) sections.push(`## Additional notes\n\n${extra}`);
  return sections.join("\n\n");
}

function extractReleaseNotes(body: string | null): string {
  if (!body) return "";
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    /^##\s+Release notes\s*#*\s*$/i.test(line),
  );
  if (start < 0) return "";
  const content: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const heading = /^(#{1,6})\s+/.exec(line);
    if (heading && heading[1].length <= 2) break;
    content.push(line);
  }
  return content.join("\n").trim();
}

function samePlan(left: ReleasePlan, right: ReleasePlan): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function ensureTagClaim(args: {
  octokit: GitHubClient;
  owner: string;
  repo: string;
  tag: string;
  sourceSha: string;
}): Promise<void> {
  const { octokit, owner, repo, tag, sourceSha } = args;
  let claimedSha: string | null = null;
  try {
    const ref = await getGitRef({
      octokit,
      owner,
      repo,
      ref: `tags/${tag}`,
    });
    claimedSha = ref.data.object.sha;
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
  if (claimedSha && claimedSha !== sourceSha) {
    throw new Error(
      `Version tag ${tag} is claimed by a different source commit`,
    );
  }
  if (claimedSha) return;
  try {
    await createGitRef({
      octokit,
      owner,
      repo,
      ref: `refs/tags/${tag}`,
      sha: sourceSha,
    });
  } catch (error) {
    if ((error as { status?: number }).status !== 422) throw error;
    const ref = await getGitRef({
      octokit,
      owner,
      repo,
      ref: `tags/${tag}`,
    });
    if (ref.data.object.sha !== sourceSha) {
      throw new Error(
        `Version tag ${tag} was concurrently claimed by a different source commit`,
      );
    }
  }
}

export async function establishAttempt(args: {
  octokit: GitHubClient;
  owner: string;
  repo: string;
  plan: ReleasePlan;
  messages: string[];
  pullRequestBody: string | null;
  targetBranch: string;
}): Promise<{
  plan: ReleasePlan;
  notes: string;
  attemptId: string;
  releaseId: number;
}> {
  const {
    octokit,
    owner,
    repo,
    plan,
    messages,
    pullRequestBody,
    targetBranch,
  } = args;
  const tag = plan.versions.next_release_tag;
  const version = plan.versions.next_release_version;
  if (!tag || !version || plan.source.sha.length !== 40) {
    throw new Error(
      "Release plan is missing an exact source SHA, version, or tag",
    );
  }
  const id = attemptId(tag, plan.source.sha);
  const releases = await listRepositoryReleases({ octokit, owner, repo });
  const matching = releases.filter((release) => release.tag_name === tag);
  const published = matching.filter((release) => !release.draft);
  const existingDrafts = matching.filter((release) => release.draft);
  if (published.length > 1) {
    throw new Error(`Multiple published attempts already exist for ${tag}`);
  }
  if (published.length === 1) {
    const release = published[0];
    const record = await readAttemptRecord({
      octokit,
      owner,
      repo,
      release,
    });
    if (
      !record ||
      record.attempt_id !== id ||
      record.source_sha !== plan.source.sha ||
      record.version !== version ||
      !samePlan(
        { ...record.plan, attempt_id: undefined },
        { ...plan, attempt_id: undefined },
      )
    ) {
      throw new Error(
        `Published release ${tag} belongs to a different source or plan`,
      );
    }
    await ensureTagClaim({
      octokit,
      owner,
      repo,
      tag,
      sourceSha: plan.source.sha,
    });
    return {
      plan: { ...plan, attempt_id: record.attempt_id },
      notes: (release.body ?? "").split(attemptMarker)[0].trim(),
      attemptId: record.attempt_id,
      releaseId: release.id,
    };
  }
  if (existingDrafts.length > 1) {
    throw new Error(`Multiple draft attempts already exist for ${tag}`);
  }
  if (existingDrafts.length === 1) {
    const release = existingDrafts[0];
    const record = await readAttemptRecord({
      octokit,
      owner,
      repo,
      release,
    });
    if (record?.abandoned) {
      throw new Error(
        `Release attempt ${record.attempt_id} was abandoned: ${record.abandoned.reason}`,
      );
    }
    if (
      !record ||
      record.source_sha !== plan.source.sha ||
      !samePlan(
        { ...record.plan, attempt_id: undefined },
        { ...plan, attempt_id: undefined },
      )
    ) {
      throw new Error(
        `Draft release ${tag} belongs to a different source or plan`,
      );
    }
    await ensureTagClaim({
      octokit,
      owner,
      repo,
      tag,
      sourceSha: plan.source.sha,
    });
    return {
      plan: { ...plan, attempt_id: record.attempt_id },
      notes: (release.body ?? "").split(attemptMarker)[0].trim(),
      attemptId: record.attempt_id,
      releaseId: release.id,
    };
  }

  await ensureTagClaim({
    octokit,
    owner,
    repo,
    tag,
    sourceSha: plan.source.sha,
  });
  const notes = releaseNotes(messages, pullRequestBody);
  const record: AttemptRecord = {
    schema_version: 1,
    attempt_id: id,
    tag,
    version,
    source_sha: plan.source.sha,
    plan: { ...plan, attempt_id: id },
  };
  const body = serializeAttemptBody(notes, record);
  const created = await createRelease({
    octokit,
    owner,
    repo,
    tag_name: tag,
    target_commitish: targetBranch,
    name: `v${version}`,
    body,
    draft: true,
    prerelease: plan.decision.channel !== "stable",
  });
  return {
    plan: record.plan,
    notes,
    attemptId: id,
    releaseId: created.data.id,
  };
}
