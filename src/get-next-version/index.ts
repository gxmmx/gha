import * as core from "@actions/core";
import * as github from "@actions/github";
import { CommitParser } from "conventional-commits-parser";
import {
  canonicalStableTag,
  fallbackBuildVersion,
  parseVersionFormat,
  previewBuildVersion,
  type VersionFormat,
} from "./version-profile";

type Bump = "none" | "patch" | "minor" | "major";
type Reason = "release" | "preview" | "no-changes" | "unmatched-branch";

interface ReleasePlan {
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
    alpha_branch: null;
    beta_branch: null;
    rc_branch: null;
    version_format: VersionFormat;
  };
  history: {
    stable_base_version: string | null;
    stable_release_tag: string | null;
    stable_release_sha: string | null;
  };
  decision: {
    channel: "stable" | null;
    bump: Bump;
    reason: Reason;
    release_required: boolean;
  };
  versions: {
    build_version: string;
    next_stable_version: string | null;
    next_release_version: string | null;
    next_release_tag: string | null;
  };
}

interface StableRelease {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
}

interface CommitEntry {
  sha: string;
  commit: { message: string };
}

const parser = new CommitParser({
  headerPattern: /^(\w+)(?:\(([^()\r\n]*)\))?(!)?: (.+)$/,
  headerCorrespondence: ["type", "scope", "breaking", "subject"],
});
const malformedConventionalHeader = /^[A-Za-z][A-Za-z0-9-]*(?:\(|!?:)/;
const semverTag = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseSemver(version: string): [number, number, number] | null {
  const match = semverTag.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function stronger(left: Bump, right: Bump): Bump {
  const strength: Record<Bump, number> = {
    none: 0,
    patch: 1,
    minor: 2,
    major: 3,
  };
  return strength[left] >= strength[right] ? left : right;
}

function bumpForMessage(message: string): Bump {
  const candidateLines = message
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, ""))
    .filter((line) => line.length > 0);
  let bump: Bump = "none";
  const wholeMessage = parser.parse(message);
  if (
    wholeMessage.header &&
    malformedConventionalHeader.test(wholeMessage.header)
  ) {
    if (!wholeMessage.type || !wholeMessage.subject) {
      throw new Error(
        `Malformed Conventional Commit message: ${wholeMessage.header}`,
      );
    }
  }
  if (wholeMessage.notes.length > 0) bump = "major";

  for (const line of candidateLines) {
    const looksConventional = malformedConventionalHeader.test(line);
    const parsed = parser.parse(line);
    if (looksConventional && (!parsed.type || !parsed.subject)) {
      throw new Error(`Malformed Conventional Commit message: ${line}`);
    }
    if (!parsed.type || !parsed.subject) continue;

    const isBreaking = parsed.breaking === "!" || parsed.notes.length > 0;
    const current: Bump = isBreaking
      ? "major"
      : parsed.type === "feat"
        ? "minor"
        : parsed.type === "fix"
          ? "patch"
          : "none";
    bump = stronger(bump, current);
  }
  return bump;
}

function nextVersion(base: string, bump: Bump): string {
  const parsed = parseSemver(base);
  if (!parsed) throw new Error(`Invalid stable release version: ${base}`);
  const [major, minor, patch] = parsed;
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  return base;
}

function makePlan(args: {
  owner: string;
  name: string;
  event: string;
  runId: number;
  sha: string;
  targetBranch: string;
  pullRequest: number | null;
  stableBranch: string;
  versionFormat: VersionFormat;
  stableBase: string | null;
  stableReleaseTag: string | null;
  stableReleaseSha: string | null;
  bump: Bump;
  reason: Reason;
  releaseRequired: boolean;
  buildVersion: string;
  nextStableVersion: string | null;
}): ReleasePlan {
  const releaseVersion = args.releaseRequired ? args.nextStableVersion : null;
  return {
    schema_version: 1,
    repository: { owner: args.owner, name: args.name },
    source: {
      event: args.event,
      run_id: args.runId,
      sha: args.sha,
      target_branch: args.targetBranch,
      pull_request: args.pullRequest,
    },
    configuration: {
      stable_branch: args.stableBranch,
      alpha_branch: null,
      beta_branch: null,
      rc_branch: null,
      version_format: args.versionFormat,
    },
    history: {
      stable_base_version: args.stableBase,
      stable_release_tag: args.stableReleaseTag,
      stable_release_sha: args.stableReleaseSha,
    },
    decision: {
      channel: args.targetBranch === args.stableBranch ? "stable" : null,
      bump: args.bump,
      reason: args.reason,
      release_required: args.releaseRequired,
    },
    versions: {
      build_version: args.buildVersion,
      next_stable_version: args.nextStableVersion,
      next_release_version: releaseVersion,
      next_release_tag: canonicalStableTag(releaseVersion),
    },
  };
}

function publishOutputs(plan: ReleasePlan): void {
  const versions = plan.versions;
  core.setOutput("build_version", versions.build_version);
  core.setOutput("next_stable_version", versions.next_stable_version ?? "");
  core.setOutput("next_release_version", versions.next_release_version ?? "");
  core.setOutput("next_release_tag", versions.next_release_tag ?? "");
  core.setOutput("release_required", String(plan.decision.release_required));
  core.setOutput("commit_sha", plan.source.sha);
  core.setOutput("channel", plan.decision.channel ?? "");
  core.setOutput("bump", plan.decision.bump);
  core.setOutput("reason", plan.decision.reason);
  core.setOutput("release_plan", JSON.stringify(plan));
}

async function main(): Promise<void> {
  const context = github.context;
  const { owner, repo: name } = context.repo;
  const token = core.getInput("github_token", { required: true });
  const octokit = github.getOctokit(token, { baseUrl: context.apiUrl });
  const repository = await octokit.rest.repos.get({ owner, repo: name });
  const stableBranch =
    core.getInput("stable_branch") || repository.data.default_branch;
  const versionFormat = parseVersionFormat(core.getInput("version_format"));
  let sourceSha = context.sha;
  let targetBranch = context.ref.replace(/^refs\/heads\//, "");
  let pullRequest: number | null = null;

  if (
    context.eventName === "pull_request" ||
    context.eventName === "pull_request_target"
  ) {
    const payload = context.payload.pull_request;
    if (!payload?.number)
      throw new Error("Pull request event is missing pull_request.number");
    pullRequest = payload.number;
    const details = await octokit.rest.pulls.get({
      owner,
      repo: name,
      pull_number: pullRequest,
    });
    sourceSha = details.data.head.sha;
    targetBranch = details.data.base.ref;
  }

  if (targetBranch !== stableBranch) {
    const unmatched = makePlan({
      owner,
      name,
      event: context.eventName,
      runId: context.runId,
      sha: sourceSha,
      targetBranch,
      pullRequest,
      stableBranch,
      versionFormat,
      stableBase: null,
      stableReleaseTag: null,
      stableReleaseSha: null,
      bump: "none",
      reason: "unmatched-branch",
      releaseRequired: false,
      buildVersion: fallbackBuildVersion(
        versionFormat,
        sourceSha,
        context.runId,
      ),
      nextStableVersion: null,
    });
    publishOutputs(unmatched);
    return;
  }

  const [releases, commits] = await Promise.all([
    octokit.paginate(octokit.rest.repos.listReleases, {
      owner,
      repo: name,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.repos.listCommits, {
      owner,
      repo: name,
      sha: sourceSha,
      per_page: 100,
    }),
  ]);
  const commitPositions = new Map(
    commits.map((commit, index) => [commit.sha, index]),
  );
  const releaseCandidates: Array<{
    tag: string;
    sha: string;
    version: string;
    position: number;
  }> = [];
  for (const release of releases as StableRelease[]) {
    if (
      release.draft ||
      release.prerelease ||
      !parseSemver(release.tag_name.replace(/^v/, ""))
    )
      continue;
    const tag = release.tag_name;
    const taggedCommit = await octokit.rest.repos.getCommit({
      owner,
      repo: name,
      ref: tag,
    });
    const position = commitPositions.get(taggedCommit.data.sha);
    if (position !== undefined) {
      releaseCandidates.push({
        tag,
        sha: taggedCommit.data.sha,
        version: tag.replace(/^v/, ""),
        position,
      });
    }
  }
  releaseCandidates.sort((left, right) => left.position - right.position);
  const baseline = releaseCandidates[0];
  const stableBase = baseline?.version ?? "0.1.0";
  const unreleasedCommits = baseline
    ? commits.slice(0, baseline.position)
    : commits;
  let bump: Bump = "none";
  for (const commit of unreleasedCommits as CommitEntry[]) {
    bump = stronger(bump, bumpForMessage(commit.commit.message));
  }

  const nextStableVersion =
    bump === "none" ? null : nextVersion(stableBase, bump);
  const preview = pullRequest !== null;
  const releaseRequired = !preview && bump !== "none";
  const reason: Reason = preview
    ? "preview"
    : bump === "none"
      ? "no-changes"
      : "release";
  const plan = makePlan({
    owner,
    name,
    event: context.eventName,
    runId: context.runId,
    sha: sourceSha,
    targetBranch,
    pullRequest,
    stableBranch,
    versionFormat,
    stableBase,
    stableReleaseTag: baseline?.tag ?? null,
    stableReleaseSha: baseline?.sha ?? null,
    bump,
    reason,
    releaseRequired,
    buildVersion: preview
      ? previewBuildVersion({
          format: versionFormat,
          prospectiveVersion: nextStableVersion,
          pullRequest: pullRequest!,
          sha: sourceSha,
          runId: context.runId,
        })
      : (nextStableVersion ??
        fallbackBuildVersion(versionFormat, sourceSha, context.runId)),
    nextStableVersion,
  });
  publishOutputs(plan);
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
