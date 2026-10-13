import * as core from "@actions/core";
import * as github from "@actions/github";
import { CommitParser } from "conventional-commits-parser";
import {
  channelForBranch,
  resolveChannelConfiguration,
  type ReleaseChannel,
} from "../get-next-version/channels";

type Bump = "none" | "patch" | "minor" | "major";
type Channel = Exclude<ReleaseChannel, null>;

interface PullRequestCommit {
  sha?: string;
  commit?: { message?: string };
}

interface AssociatedPullRequest {
  number: number;
  merged_at: string | null;
  merge_commit_sha: string | null;
  base: { ref: string };
}

interface CommitStatus {
  context: string;
  state: string;
  description: string | null;
}

interface Signal {
  bump: Bump;
  titleType: string | null;
  breaking: boolean;
}

const parser = new CommitParser({
  headerPattern: /^([A-Za-z][A-Za-z0-9-]*)(?:\(([^()\r\n]*)\))?(!)?: (.+)$/,
  headerCorrespondence: ["type", "scope", "breaking", "subject"],
});
const conventionalLooking = /^[A-Za-z][A-Za-z0-9-]*(?:\(|!?:)/;
const bumpStrength: Record<Bump, number> = {
  none: 0,
  patch: 1,
  minor: 2,
  major: 3,
};

function stronger(left: Bump, right: Bump): Bump {
  return bumpStrength[left] >= bumpStrength[right] ? left : right;
}

function signalForMessage(message: string): Signal {
  const wholeMessage = parser.parse(message);
  if (
    wholeMessage.header &&
    conventionalLooking.test(wholeMessage.header) &&
    (!wholeMessage.type || !wholeMessage.subject)
  ) {
    throw new Error(
      `Malformed Conventional Commit message: ${wholeMessage.header}`,
    );
  }

  let bump: Bump = wholeMessage.notes.length > 0 ? "major" : "none";
  let titleType: string | null = null;
  let breaking = wholeMessage.notes.length > 0;
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, ""))
    .filter((line) => line.length > 0);

  for (const line of lines) {
    const parsed = parser.parse(line);
    const looksConventional = conventionalLooking.test(line);
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
    breaking ||= isBreaking;
    if (bumpStrength[current] > bumpStrength[bump]) {
      bump = current;
      titleType = parsed.type;
    } else if (titleType === null && parsed.type) {
      titleType = parsed.type;
    }
  }

  return { bump, titleType, breaking };
}

function strongestSignal(messages: string[]): Signal {
  let bump: Bump = "none";
  let titleType: string | null = null;
  let breaking = false;
  for (const message of messages) {
    const signal = signalForMessage(message);
    if (bumpStrength[signal.bump] > bumpStrength[bump]) {
      bump = signal.bump;
      titleType = signal.titleType;
    } else if (titleType === null && signal.titleType !== null) {
      titleType = signal.titleType;
    }
    breaking ||= signal.breaking;
  }
  return { bump, titleType, breaking };
}

function normalizeTitle(title: string, signal: Signal): string {
  if (signal.bump === "none" || !signal.titleType) return title;
  const match =
    /^([A-Za-z][A-Za-z0-9-]*)(?:\(([^()\r\n]*)\))?(!)?:\s*(.+)$/.exec(title);
  const scope = match?.[2] ? `(${match[2]})` : "";
  const description = (match?.[4] ?? title).trim();
  if (!description) {
    throw new Error("Pull request title must include a description");
  }
  const marker = signal.breaking ? "!" : "";
  return `${signal.titleType}${scope}${marker}: ${description}`;
}

function setOutputs(values: {
  prepared: boolean;
  reason: string;
  title: string;
  titleUpdated: boolean;
  titleUpdateError?: string;
  bump: Bump;
  channel: Channel | null;
  releaseRequired: boolean;
  pullRequest: number;
  decisionSha?: string;
  decisionContext?: string;
}): void {
  core.setOutput("prepared", String(values.prepared));
  core.setOutput("reason", values.reason);
  core.setOutput("title", values.title);
  core.setOutput("title_updated", String(values.titleUpdated));
  core.setOutput("title_update_error", values.titleUpdateError ?? "");
  core.setOutput("bump", values.bump);
  core.setOutput("channel", values.channel ?? "");
  core.setOutput("release_required", String(values.releaseRequired));
  core.setOutput("pull_request", String(values.pullRequest));
  core.setOutput("decision_sha", values.decisionSha ?? "");
  core.setOutput("decision_context", values.decisionContext ?? "");
}

function decisionContext(channel: Channel): string {
  return `gha/release-decision/${channel}`;
}

function parseDecision(description: string | null): {
  reason: "release" | "no-changes" | "suppressed";
  bump: Bump;
} {
  const match =
    /^v1;reason=(release|no-changes|suppressed);bump=(none|patch|minor|major)$/.exec(
      description ?? "",
    );
  if (!match) throw new Error("Recorded release decision status is invalid");
  return {
    reason: match[1] as "release" | "no-changes" | "suppressed",
    bump: match[2] as Bump,
  };
}

async function preparePush(args: {
  context: typeof github.context;
  octokit: ReturnType<typeof github.getOctokit>;
  owner: string;
  repo: string;
  targetBranch: string;
  channel: Channel | null;
  noReleaseLabel: string;
}): Promise<void> {
  const { context, octokit, owner, repo, targetBranch, channel } = args;
  if (channel === null) {
    setOutputs({
      prepared: false,
      reason: "unmatched-branch",
      title: "",
      titleUpdated: false,
      bump: "none",
      channel,
      releaseRequired: false,
      pullRequest: 0,
    });
    return;
  }

  const sourceSha = context.sha;
  const payloadSha = context.payload.after;
  if (
    !/^refs\/heads\//.test(context.ref) ||
    !sourceSha ||
    payloadSha !== sourceSha
  ) {
    throw new Error(
      "Release preparation requires the exact pushed branch commit SHA",
    );
  }
  const associated = (await octokit.paginate(
    octokit.rest.repos.listPullRequestsAssociatedWithCommit,
    {
      owner,
      repo,
      commit_sha: sourceSha,
    },
  )) as AssociatedPullRequest[];
  const matching = associated.filter(
    (pull) =>
      pull.merged_at !== null &&
      pull.merge_commit_sha === sourceSha &&
      pull.base?.ref === targetBranch,
  );
  if (matching.length !== 1) {
    throw new Error(
      `Pushed commit ${sourceSha} is not the exact squash commit of one merged PR targeting ${targetBranch}`,
    );
  }
  const pullRequest = matching[0];
  const contextName = decisionContext(channel);
  const statuses = (await octokit.paginate(
    octokit.rest.repos.listCommitStatusesForRef,
    {
      owner,
      repo,
      ref: sourceSha,
      per_page: 100,
    },
  )) as CommitStatus[];
  const existing = statuses.find((status) => status.context === contextName);
  if (existing) {
    if (existing.state !== "success") {
      throw new Error(
        `Recorded release decision status ${contextName} is not successful`,
      );
    }
    const recorded = parseDecision(existing.description);
    setOutputs({
      prepared: true,
      reason: recorded.reason,
      title: "",
      titleUpdated: false,
      bump: recorded.reason === "suppressed" ? "none" : recorded.bump,
      channel,
      releaseRequired: recorded.reason === "release",
      pullRequest: pullRequest.number,
      decisionSha: sourceSha,
      decisionContext: contextName,
    });
    return;
  }

  const pull = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullRequest.number,
  });
  if (
    pull.data.merged_at == null ||
    pull.data.merge_commit_sha !== sourceSha ||
    pull.data.base.ref !== targetBranch
  ) {
    throw new Error(
      "Associated pull request no longer matches the pushed squash commit",
    );
  }
  const commits = (await octokit.paginate(octokit.rest.pulls.listCommits, {
    owner,
    repo,
    pull_number: pullRequest.number,
    per_page: 100,
  })) as PullRequestCommit[];
  if (commits.length === 0 || commits.length >= 250) {
    throw new Error(
      "Pull request commit history is empty, incomplete, or truncated",
    );
  }
  const messages = commits.map((commit) => {
    if (!commit.sha || typeof commit.commit?.message !== "string") {
      throw new Error("Pull request commit history is incomplete");
    }
    return commit.commit.message;
  });
  const signal = strongestSignal(messages);
  const suppressed = pull.data.labels.some(
    (item) => item.name === args.noReleaseLabel,
  );
  const reason = suppressed
    ? "suppressed"
    : signal.bump === "none"
      ? "no-changes"
      : "release";
  const bump = reason === "suppressed" ? "none" : signal.bump;
  const description = `v1;reason=${reason};bump=${bump}`;
  await octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: sourceSha,
    state: "success",
    context: contextName,
    description,
  });
  setOutputs({
    prepared: true,
    reason,
    title: "",
    titleUpdated: false,
    bump,
    channel,
    releaseRequired: reason === "release",
    pullRequest: pullRequest.number,
    decisionSha: sourceSha,
    decisionContext: contextName,
  });
}

async function main(): Promise<void> {
  const context = github.context;
  const { owner, repo } = context.repo;
  const token = core.getInput("github_token", { required: true });
  const octokit = github.getOctokit(token, { baseUrl: context.apiUrl });
  const repository = await octokit.rest.repos.get({ owner, repo });
  const configuration = resolveChannelConfiguration({
    defaultBranch: repository.data.default_branch,
    stableBranchInput: core.getInput("stable_branch"),
    alphaBranchInput: core.getInput("alpha_branch"),
    betaBranchInput: core.getInput("beta_branch"),
    rcBranchInput: core.getInput("rc_branch"),
    versionFormatInput: "semver",
  });
  if (context.eventName === "push") {
    const targetBranch = context.ref.replace(/^refs\/heads\//, "");
    const channel = channelForBranch(configuration, targetBranch);
    await preparePush({
      context,
      octokit,
      owner,
      repo,
      targetBranch,
      channel,
      noReleaseLabel: core.getInput("no_release_label") || "no-release",
    });
    return;
  }
  if (
    context.eventName !== "pull_request" &&
    context.eventName !== "pull_request_target"
  ) {
    throw new Error(
      "prepare-release requires a pull_request or release-branch push event",
    );
  }
  const payload = context.payload.pull_request;
  if (!payload?.number)
    throw new Error("Pull request event is missing pull_request.number");
  const pull = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: payload.number,
  });
  const targetBranch = pull.data.base.ref;
  const channel = channelForBranch(configuration, targetBranch);

  if (channel === null) {
    setOutputs({
      prepared: false,
      reason: "unmatched-branch",
      title: pull.data.title,
      titleUpdated: false,
      bump: "none",
      channel,
      releaseRequired: false,
      pullRequest: payload.number,
    });
    return;
  }

  const commits = (await octokit.paginate(octokit.rest.pulls.listCommits, {
    owner,
    repo,
    pull_number: payload.number,
    per_page: 100,
  })) as PullRequestCommit[];
  if (commits.length === 0) {
    throw new Error("Pull request commit history is empty or incomplete");
  }
  if (commits.length >= 250) {
    throw new Error(
      "Pull request has 250 or more commits; GitHub may have truncated the history",
    );
  }
  const messages = commits.map((commit) => {
    if (!commit.sha || typeof commit.commit?.message !== "string") {
      throw new Error("Pull request commit history is incomplete");
    }
    return commit.commit.message;
  });
  const signal = strongestSignal(messages);
  const label = core.getInput("no_release_label") || "no-release";
  const suppressed = pull.data.labels.some((item) => item.name === label);
  const requireRelease = core.getInput("require_release") !== "false";
  if (
    channel === "stable" &&
    requireRelease &&
    signal.bump === "none" &&
    !suppressed
  ) {
    throw new Error(
      `Stable-target PR requires a release-worthy change or the ${label} label`,
    );
  }

  const releaseRequired = signal.bump !== "none" && !suppressed;
  const title = normalizeTitle(pull.data.title, signal);
  let titleUpdated = title === pull.data.title;
  let titleUpdateError: string | undefined;
  if (!titleUpdated) {
    try {
      await octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: payload.number,
        title,
      });
      titleUpdated = true;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 403 && status !== 404) throw error;
      titleUpdateError =
        "Title normalization is unavailable because the token lacks pull-requests: write permission";
      core.warning(titleUpdateError);
    }
  }

  setOutputs({
    prepared: true,
    reason: suppressed
      ? "suppressed"
      : signal.bump === "none"
        ? "no-changes"
        : "release",
    title,
    titleUpdated,
    titleUpdateError,
    bump: suppressed ? "none" : signal.bump,
    channel,
    releaseRequired,
    pullRequest: payload.number,
  });
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
