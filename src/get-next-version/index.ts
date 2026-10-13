import * as core from "@actions/core";
import * as github from "@actions/github";
import { CommitParser } from "conventional-commits-parser";
import {
  channelForBranch,
  resolveChannelConfiguration,
  type ChannelConfiguration,
  type ReleaseChannel,
} from "./channels.js";
import {
  canonicalCandidateTag,
  compareStableVersions,
  formatCandidateVersion,
  formatStableVersion,
  parseCandidateTag,
  parseStableSemver,
} from "./versions.js";
import {
  canonicalStableTag,
  fallbackBuildVersion,
  previewBuildVersion,
  type VersionFormat,
} from "./version-profile.js";

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
    alpha_branch: string | null;
    beta_branch: string | null;
    rc_branch: string | null;
    version_format: VersionFormat;
  };
  history: {
    stable_base_version: string | null;
    stable_release_tag: string | null;
    stable_release_sha: string | null;
  };
  decision: {
    channel: ReleaseChannel;
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

interface RepositoryTag {
  name: string;
  commit: { sha: string };
}

interface CommitEntry {
  sha: string;
  commit: { message: string };
}

const parser = new CommitParser({
  headerPattern: /^([A-Za-z][A-Za-z0-9-]*)(?:\(([^()\r\n]*)\))?(!)?: (.+)$/,
  headerCorrespondence: ["type", "scope", "breaking", "subject"],
});
const malformedConventionalHeader = /^[A-Za-z][A-Za-z0-9-]*(?:\(|!?:)/;
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
  const parsed = parseStableSemver(base);
  if (!parsed) throw new Error(`Invalid stable release version: ${base}`);
  const { major, minor, patch } = parsed;
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
  configuration: ChannelConfiguration;
  channel: ReleaseChannel;
  stableBase: string | null;
  stableReleaseTag: string | null;
  stableReleaseSha: string | null;
  bump: Bump;
  reason: Reason;
  releaseRequired: boolean;
  buildVersion: string;
  nextStableVersion: string | null;
  nextReleaseVersion: string | null;
  nextReleaseTag: string | null;
}): ReleasePlan {
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
      alpha_branch: args.configuration.alphaBranch,
      beta_branch: args.configuration.betaBranch,
      rc_branch: args.configuration.rcBranch,
      version_format: args.configuration.versionFormat,
    },
    history: {
      stable_base_version: args.stableBase,
      stable_release_tag: args.stableReleaseTag,
      stable_release_sha: args.stableReleaseSha,
    },
    decision: {
      channel: args.channel,
      bump: args.bump,
      reason: args.reason,
      release_required: args.releaseRequired,
    },
    versions: {
      build_version: args.buildVersion,
      next_stable_version: args.nextStableVersion,
      next_release_version: args.nextReleaseVersion,
      next_release_tag: args.nextReleaseTag,
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
  const configuration = resolveChannelConfiguration({
    defaultBranch: repository.data.default_branch,
    stableBranchInput: core.getInput("stable_branch"),
    alphaBranchInput: core.getInput("alpha_branch"),
    betaBranchInput: core.getInput("beta_branch"),
    rcBranchInput: core.getInput("rc_branch"),
    versionFormatInput: core.getInput("version_format"),
  });
  const stableBranch = configuration.stableBranch;
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

  const channel = channelForBranch(configuration, targetBranch);
  if (channel === null) {
    const unmatched = makePlan({
      owner,
      name,
      event: context.eventName,
      runId: context.runId,
      sha: sourceSha,
      targetBranch,
      pullRequest,
      stableBranch,
      configuration,
      channel,
      stableBase: null,
      stableReleaseTag: null,
      stableReleaseSha: null,
      bump: "none",
      reason: "unmatched-branch",
      releaseRequired: false,
      buildVersion: fallbackBuildVersion(
        configuration.versionFormat,
        sourceSha,
        context.runId,
      ),
      nextStableVersion: null,
      nextReleaseVersion: null,
      nextReleaseTag: null,
    });
    publishOutputs(unmatched);
    return;
  }

  const [releases, commits, tags] = await Promise.all([
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
    octokit.paginate(octokit.rest.repos.listTags, {
      owner,
      repo: name,
      per_page: 100,
    }),
  ]);
  const commitPositions = new Map(
    commits.map((commit, index) => [commit.sha, index]),
  );
  const stableReleases: Array<{
    tag: string;
    sha: string;
    version: string;
    position: number | undefined;
  }> = [];
  const candidateReleases: Array<{
    tag: string;
    sha: string;
    base: string;
    channel: "alpha" | "beta" | "rc";
    counter: number;
  }> = [];
  const tagClaims = new Map(
    (tags as RepositoryTag[]).map((tag) => [tag.name, tag.commit.sha]),
  );
  for (const release of releases as StableRelease[]) {
    if (release.draft) continue;
    const stableVersion = release.prerelease
      ? null
      : release.tag_name.replace(/^v/, "");
    const parsedCandidate = release.prerelease
      ? parseCandidateTag(release.tag_name)
      : null;
    if (!stableVersion || !parseStableSemver(stableVersion)) {
      if (!parsedCandidate) continue;
    }
    const tag = release.tag_name;
    const taggedCommit = await octokit.rest.repos.getCommit({
      owner,
      repo: name,
      ref: tag,
    });
    const sha = taggedCommit.data.sha;
    if (stableVersion && parseStableSemver(stableVersion)) {
      stableReleases.push({
        tag,
        sha,
        version: stableVersion,
        position: commitPositions.get(sha),
      });
    } else if (parsedCandidate) {
      candidateReleases.push({ tag, sha, ...parsedCandidate });
    }
  }
  for (const [tag, sha] of tagClaims) {
    const stableVersion = tag.replace(/^v/, "");
    if (parseStableSemver(stableVersion)) continue;
    const parsedCandidate = parseCandidateTag(tag);
    if (
      parsedCandidate &&
      !candidateReleases.some((release) => release.tag === tag)
    ) {
      candidateReleases.push({ tag, sha, ...parsedCandidate });
    }
  }
  const reachableStableReleases = stableReleases.filter(
    (release) => release.position !== undefined,
  );
  const latestStableRelease = stableReleases.sort((left, right) =>
    compareStableVersions(right.version, left.version),
  )[0];
  const preview = pullRequest !== null;
  if (
    channel !== "stable" &&
    !preview &&
    latestStableRelease &&
    latestStableRelease.position === undefined
  ) {
    throw new Error(
      `Candidate branch ${targetBranch} is behind the latest stable release ${latestStableRelease.tag}`,
    );
  }
  reachableStableReleases.sort(
    (left, right) => left.position! - right.position!,
  );
  const baseline =
    channel === "stable" ? reachableStableReleases[0] : latestStableRelease;
  const stableBase = baseline?.version ?? "0.1.0";
  const unreleasedCommits = baseline
    ? commits.slice(0, baseline.position ?? commits.length)
    : commits;
  let bump: Bump = "none";
  for (const commit of unreleasedCommits as CommitEntry[]) {
    bump = stronger(bump, bumpForMessage(commit.commit.message));
  }

  let nextStableVersion =
    bump === "none" ? null : nextVersion(stableBase, bump);
  const releaseRequired = !preview && bump !== "none";
  const reason: Reason = preview
    ? "preview"
    : bump === "none"
      ? "no-changes"
      : "release";
  let nextReleaseVersion: string | null = null;
  let nextReleaseTag: string | null = null;
  if (releaseRequired && nextStableVersion) {
    if (channel === "stable") {
      let allocatedStableVersion = nextStableVersion;
      while (true) {
        const tag = `v${allocatedStableVersion}`;
        const claimSha = tagClaims.get(tag);
        if (!claimSha || claimSha === sourceSha) {
          nextStableVersion = allocatedStableVersion;
          nextReleaseVersion = formatStableVersion(
            allocatedStableVersion,
            configuration.versionFormat,
          );
          nextReleaseTag = tag;
          break;
        }
        allocatedStableVersion = nextVersion(allocatedStableVersion, "patch");
      }
    } else {
      const matchingRerun = candidateReleases.find(
        (release) => release.channel === channel && release.sha === sourceSha,
      );
      const counter =
        matchingRerun?.counter ??
        Math.max(
          0,
          ...candidateReleases
            .filter(
              (release) =>
                release.channel === channel &&
                release.base === nextStableVersion,
            )
            .map((release) => release.counter),
        ) + 1;
      const candidateBase = matchingRerun?.base ?? nextStableVersion;
      nextReleaseVersion = formatCandidateVersion(
        candidateBase,
        channel,
        counter,
        configuration.versionFormat,
      );
      nextReleaseTag =
        matchingRerun?.tag ??
        canonicalCandidateTag(nextStableVersion, channel, counter);
    }
  }
  const formattedNextStableVersion = nextStableVersion
    ? formatStableVersion(nextStableVersion, configuration.versionFormat)
    : null;
  const buildVersion = preview
    ? previewBuildVersion({
        format: configuration.versionFormat,
        prospectiveVersion: formattedNextStableVersion,
        pullRequest: pullRequest!,
        sha: sourceSha,
        runId: context.runId,
      })
    : (nextReleaseVersion ??
      formattedNextStableVersion ??
      fallbackBuildVersion(
        configuration.versionFormat,
        sourceSha,
        context.runId,
      ));
  const plan = makePlan({
    owner,
    name,
    event: context.eventName,
    runId: context.runId,
    sha: sourceSha,
    targetBranch,
    pullRequest,
    stableBranch,
    configuration,
    channel,
    stableBase,
    stableReleaseTag: baseline?.tag ?? null,
    stableReleaseSha: baseline?.sha ?? null,
    bump,
    reason,
    releaseRequired,
    buildVersion,
    nextStableVersion: formattedNextStableVersion,
    nextReleaseVersion,
    nextReleaseTag,
  });
  publishOutputs(plan);
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
