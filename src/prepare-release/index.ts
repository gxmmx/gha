import * as core from "@actions/core";
import * as github from "@actions/github";
import { establishAttempt, parseAttempt, type ReleasePlan } from "./attempt.js";
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
  attemptId?: string;
  releaseId?: number;
  releaseNotes?: string;
  releasePlan?: ReleasePlan;
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
  core.setOutput("attempt_id", values.attemptId ?? "");
  core.setOutput("draft_release_id", values.releaseId?.toString() ?? "");
  core.setOutput("release_notes", values.releaseNotes ?? "");
  core.setOutput(
    "release_plan",
    values.releasePlan ? JSON.stringify(values.releasePlan) : "",
  );
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

function compareStableVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

async function assertStablePredecessorsResolved(args: {
  octokit: ReturnType<typeof github.getOctokit>;
  owner: string;
  repo: string;
  history: Array<{ sha: string; commit: { message: string } }>;
  baselineSha: string | null;
  currentSha: string;
}): Promise<void> {
  const { octokit, owner, repo, history, baselineSha, currentSha } = args;
  const currentIndex = history.findIndex((entry) => entry.sha === currentSha);
  if (currentIndex !== 0) {
    throw new Error(
      "Release history does not start at the exact pushed commit",
    );
  }
  const baselineIndex = baselineSha
    ? history.findIndex((entry) => entry.sha === baselineSha)
    : -1;
  if (baselineSha && baselineIndex < 0) {
    throw new Error("Stable release baseline is missing from release history");
  }

  const predecessorHistory = history.slice(
    1,
    baselineIndex < 0 ? undefined : baselineIndex,
  );
  if (predecessorHistory.length === 0) return;
  const contextName = decisionContext("stable");
  const statusSets = await Promise.all(
    predecessorHistory.map(async (entry) => {
      const statuses = (await octokit.paginate(
        octokit.rest.repos.listCommitStatusesForRef,
        { owner, repo, ref: entry.sha, per_page: 100 },
      )) as CommitStatus[];
      return statuses.find((status) => status.context === contextName);
    }),
  );

  let trackedLength = predecessorHistory.length;
  if (baselineIndex < 0) {
    let oldestTracked = -1;
    for (let index = 0; index < statusSets.length; index += 1) {
      if (statusSets[index]) oldestTracked = index;
    }
    if (oldestTracked < 0) return;
    trackedLength = oldestTracked;
  }
  const releases = (await octokit.paginate(octokit.rest.repos.listReleases, {
    owner,
    repo,
    per_page: 100,
  })) as Array<{
    id: number;
    draft: boolean;
    prerelease: boolean;
    body?: string | null;
  }>;
  const attempts = releases.flatMap((release) => {
    const attempt = parseAttempt(release.body);
    return attempt ? [{ release, attempt }] : [];
  });

  const latestStableByMajor = new Map<
    number,
    { version: string; sourceSha: string; aliasEnabled: boolean }
  >();
  for (const { release, attempt } of attempts) {
    if (release.draft || release.prerelease) continue;
    const stableVersion = /^(0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.exec(
      attempt.version,
    );
    if (!stableVersion) continue;
    const major = Number(stableVersion[1]);
    const previous = latestStableByMajor.get(major);
    const newer =
      !previous || compareStableVersions(attempt.version, previous.version) > 0;
    if (newer) {
      latestStableByMajor.set(major, {
        version: attempt.version,
        sourceSha: attempt.source_sha,
        aliasEnabled: attempt.major_alias_enabled === true,
      });
    }
  }
  for (const [major, latest] of latestStableByMajor) {
    if (!latest.aliasEnabled) continue;
    let aliasSha: string | null = null;
    try {
      const alias = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `tags/v${major}`,
      });
      aliasSha = alias.data.object.sha;
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
    if (aliasSha !== latest.sourceSha) {
      throw new Error(
        `Stable major alias v${major} is unresolved for release ${latest.version}; repair it or explicitly disable alias updates before building another stable release`,
      );
    }
  }

  for (let index = 0; index < trackedLength; index += 1) {
    const entry = predecessorHistory[index];
    const status = statusSets[index];
    if (!status || status.state !== "success") {
      throw new Error(
        `Unresolved predecessor commit ${entry.sha}: stable release decision is missing; rerun its release workflow before continuing`,
      );
    }
    const decision = parseDecision(status.description);
    if (decision.reason !== "release") continue;
    const matching = attempts.filter(
      ({ attempt }) => attempt.source_sha === entry.sha,
    );
    const resolved = matching.some(
      ({ release, attempt }) =>
        attempt.abandoned !== undefined ||
        (!release.draft && !release.prerelease),
    );
    if (!resolved) {
      throw new Error(
        `Unresolved predecessor commit ${entry.sha}: its stable release attempt is not published or abandoned; recover it before continuing`,
      );
    }
  }
}

async function preparePush(args: {
  context: typeof github.context;
  octokit: ReturnType<typeof github.getOctokit>;
  owner: string;
  repo: string;
  targetBranch: string;
  channel: Channel | null;
  noReleaseLabel: string;
  configuration: ReturnType<typeof resolveChannelConfiguration>;
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
  let recorded: ReturnType<typeof parseDecision> | null = null;
  if (existing) {
    if (existing.state !== "success") {
      throw new Error(
        `Recorded release decision status ${contextName} is not successful`,
      );
    }
    recorded = parseDecision(existing.description);
  }
  if (recorded && recorded.reason !== "release") {
    setOutputs({
      prepared: true,
      reason: recorded.reason,
      title: "",
      titleUpdated: false,
      bump: recorded.reason === "suppressed" ? "none" : recorded.bump,
      channel,
      releaseRequired: false,
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
  let reason = recorded?.reason;
  let bump = recorded?.bump;
  let messages: string[] = [];
  if (!recorded) {
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
    messages = commits.map((commit) => {
      if (!commit.sha || typeof commit.commit?.message !== "string") {
        throw new Error("Pull request commit history is incomplete");
      }
      return commit.commit.message;
    });
    const signal = strongestSignal(messages);
    const suppressed = pull.data.labels.some(
      (item) => item.name === args.noReleaseLabel,
    );
    reason = suppressed
      ? "suppressed"
      : signal.bump === "none"
        ? "no-changes"
        : "release";
    bump = reason === "suppressed" ? "none" : signal.bump;
    await octokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: sourceSha,
      state: "success",
      context: contextName,
      description: `v1;reason=${reason};bump=${bump}`,
    });
  }
  if (reason === "release") {
    const planText = core.getInput("release_plan", { required: true });
    let plan: ReleasePlan;
    try {
      plan = JSON.parse(planText) as ReleasePlan;
    } catch {
      throw new Error("release_plan must be valid JSON from get-next-version");
    }
    const expected = {
      owner,
      name: repo,
      event: context.eventName,
      run_id: context.runId,
      sha: sourceSha,
      target_branch: targetBranch,
      pull_request: null,
      configuration: {
        stable_branch: args.configuration.stableBranch,
        alpha_branch: args.configuration.alphaBranch,
        beta_branch: args.configuration.betaBranch,
        rc_branch: args.configuration.rcBranch,
        version_format: args.configuration.versionFormat,
      },
    };
    if (
      plan?.schema_version !== 1 ||
      plan.repository?.owner !== expected.owner ||
      plan.repository?.name !== expected.name ||
      plan.source?.event !== expected.event ||
      plan.source?.run_id !== expected.run_id ||
      plan.source?.sha !== expected.sha ||
      plan.source?.target_branch !== expected.target_branch ||
      plan.source?.pull_request !== expected.pull_request ||
      JSON.stringify(plan.configuration) !==
        JSON.stringify(expected.configuration) ||
      plan.decision?.channel !== channel ||
      plan.decision?.reason !== "release" ||
      plan.decision?.release_required !== true ||
      plan.decision?.bump !== bump ||
      !plan.versions?.next_release_tag ||
      !plan.versions?.next_release_version
    ) {
      throw new Error(
        "release_plan is stale or does not match the pushed release decision; run get-next-version again",
      );
    }
    const history = (await octokit.paginate(octokit.rest.repos.listCommits, {
      owner,
      repo,
      sha: sourceSha,
      per_page: 100,
    })) as Array<{ sha: string; commit: { message: string } }>;
    if (
      !history.length ||
      !history.every(
        (entry) => entry.sha && typeof entry.commit?.message === "string",
      )
    ) {
      throw new Error("Release history is incomplete");
    }
    const baseline = plan.history.stable_release_sha;
    const baselineIndex = baseline
      ? history.findIndex((entry) => entry.sha === baseline)
      : -1;
    if (baseline && baselineIndex < 0)
      throw new Error(
        "release_plan stable baseline is stale; run get-next-version again",
      );
    messages = history
      .slice(0, baselineIndex < 0 ? history.length : baselineIndex)
      .map((entry) => entry.commit.message);
    if (channel === "stable") {
      await assertStablePredecessorsResolved({
        octokit,
        owner,
        repo,
        history,
        baselineSha: baseline,
        currentSha: sourceSha,
      });
    }
    const attempt = await establishAttempt({
      octokit,
      owner,
      repo,
      plan,
      messages,
      pullRequestBody: pull.data.body,
      targetBranch,
    });
    setOutputs({
      prepared: true,
      reason,
      title: "",
      titleUpdated: false,
      bump: bump!,
      channel,
      releaseRequired: true,
      pullRequest: pullRequest.number,
      decisionSha: sourceSha,
      decisionContext: contextName,
      attemptId: attempt.attemptId,
      releaseId: attempt.releaseId,
      releaseNotes: attempt.notes,
      releasePlan: attempt.plan,
    });
    return;
  }
  setOutputs({
    prepared: true,
    reason: reason!,
    title: "",
    titleUpdated: false,
    bump: bump!,
    channel,
    releaseRequired: false,
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
      configuration,
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
