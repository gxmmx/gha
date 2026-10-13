import * as github from "@actions/github";
import { CommitParser } from "conventional-commits-parser";

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

interface AttemptRecord {
  schema_version: 1;
  attempt_id: string;
  tag: string;
  version: string;
  source_sha: string;
  plan: ReleasePlan;
}

const marker = "<!-- gxmmx-release-attempt:v1 -->";
const parser = new CommitParser();

function attemptId(tag: string, sha: string): string {
  return `${tag.replace(/[^A-Za-z0-9.-]/g, "-")}@${sha.slice(0, 12)}`;
}

function parseAttempt(body: string | null | undefined): AttemptRecord | null {
  if (!body) return null;
  const start = body.indexOf(marker);
  if (start < 0) return null;
  const json = body
    .slice(start + marker.length)
    .trim()
    .split("\n")[0];
  try {
    const value = JSON.parse(json) as AttemptRecord;
    return value.schema_version === 1 && value.attempt_id ? value : null;
  } catch {
    return null;
  }
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
  octokit: ReturnType<typeof github.getOctokit>;
  owner: string;
  repo: string;
  tag: string;
  sourceSha: string;
}): Promise<void> {
  const { octokit, owner, repo, tag, sourceSha } = args;
  let claimedSha: string | null = null;
  try {
    const ref = await octokit.rest.git.getRef({
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
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/tags/${tag}`,
      sha: sourceSha,
    });
  } catch (error) {
    if ((error as { status?: number }).status !== 422) throw error;
    const ref = await octokit.rest.git.getRef({
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
  octokit: ReturnType<typeof github.getOctokit>;
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
  const releases = await octokit.paginate(octokit.rest.repos.listReleases, {
    owner,
    repo,
    per_page: 100,
  });
  const matching = releases.filter((release) => release.tag_name === tag);
  const existingDrafts = matching.filter((release) => release.draft);
  if (matching.some((release) => !release.draft)) {
    throw new Error(`Release tag ${tag} is already published`);
  }
  if (existingDrafts.length > 1) {
    throw new Error(`Multiple draft attempts already exist for ${tag}`);
  }
  if (existingDrafts.length === 1) {
    const release = existingDrafts[0];
    const record = parseAttempt(release.body);
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
      notes: (release.body ?? "").split(marker)[0].trim(),
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
  const body = `${notes}\n\n${marker}\n${JSON.stringify(record)}`;
  const created = await octokit.rest.repos.createRelease({
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
