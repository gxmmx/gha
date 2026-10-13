import * as github from "@actions/github";

export type GitHubClient = ReturnType<typeof github.getOctokit>;

export interface GitHubOperations {
  octokit: GitHubClient;
  owner: string;
  repo: string;
}

export type RepositoryContext = Pick<
  GitHubOperations,
  "octokit" | "owner" | "repo"
>;

export function createGitHubOperations(token: string): GitHubOperations {
  const context = github.context;
  return {
    octokit: github.getOctokit(token, { baseUrl: context.apiUrl }),
    owner: context.repo.owner,
    repo: context.repo.repo,
  };
}

export function getRepository(args: RepositoryContext) {
  return args.octokit.rest.repos.get({ owner: args.owner, repo: args.repo });
}

export function listRepositoryReleases(args: RepositoryContext) {
  return args.octokit.paginate(args.octokit.rest.repos.listReleases, {
    owner: args.owner,
    repo: args.repo,
    per_page: 100,
  });
}

export function listRepositoryCommits(
  args: RepositoryContext & { sha?: string; perPage?: number },
) {
  return args.octokit.paginate(args.octokit.rest.repos.listCommits, {
    owner: args.owner,
    repo: args.repo,
    ...(args.sha ? { sha: args.sha } : {}),
    per_page: args.perPage ?? 100,
  });
}

export function listRepositoryTags(args: RepositoryContext) {
  return args.octokit.paginate(args.octokit.rest.repos.listTags, {
    owner: args.owner,
    repo: args.repo,
    per_page: 100,
  });
}

export function getRepositoryCommit(args: RepositoryContext & { ref: string }) {
  return args.octokit.rest.repos.getCommit({
    owner: args.owner,
    repo: args.repo,
    ref: args.ref,
  });
}

export function getPullRequest(
  args: RepositoryContext & { pullNumber: number },
) {
  return args.octokit.rest.pulls.get({
    owner: args.owner,
    repo: args.repo,
    pull_number: args.pullNumber,
  });
}

export function listPullRequestCommits(
  args: RepositoryContext & { pullNumber: number },
) {
  return args.octokit.paginate(args.octokit.rest.pulls.listCommits, {
    owner: args.owner,
    repo: args.repo,
    pull_number: args.pullNumber,
    per_page: 100,
  });
}

export function listPullRequestsAssociatedWithCommit(
  args: RepositoryContext & { commitSha: string },
) {
  return args.octokit.paginate(
    args.octokit.rest.repos.listPullRequestsAssociatedWithCommit,
    { owner: args.owner, repo: args.repo, commit_sha: args.commitSha },
  );
}

export function listCommitStatuses(args: RepositoryContext & { ref: string }) {
  return args.octokit.paginate(
    args.octokit.rest.repos.listCommitStatusesForRef,
    { owner: args.owner, repo: args.repo, ref: args.ref, per_page: 100 },
  );
}

export function createCommitStatus(
  args: RepositoryContext & {
    sha: string;
    state: "error" | "failure" | "pending" | "success";
    context: string;
    description: string;
  },
) {
  return args.octokit.rest.repos.createCommitStatus({
    owner: args.owner,
    repo: args.repo,
    sha: args.sha,
    state: args.state,
    context: args.context,
    description: args.description,
  });
}

export function updatePullRequestTitle(
  args: RepositoryContext & { pullNumber: number; title: string },
) {
  return args.octokit.rest.pulls.update({
    owner: args.owner,
    repo: args.repo,
    pull_number: args.pullNumber,
    title: args.title,
  });
}

export function getGitRef(args: RepositoryContext & { ref: string }) {
  return args.octokit.rest.git.getRef({
    owner: args.owner,
    repo: args.repo,
    ref: args.ref,
  });
}

export function createGitRef(
  args: RepositoryContext & { ref: string; sha: string },
) {
  return args.octokit.rest.git.createRef({
    owner: args.owner,
    repo: args.repo,
    ref: args.ref,
    sha: args.sha,
  });
}

export function updateGitRef(
  args: RepositoryContext & { ref: string; sha: string; force: boolean },
) {
  return args.octokit.rest.git.updateRef({
    owner: args.owner,
    repo: args.repo,
    ref: args.ref,
    sha: args.sha,
    force: args.force,
  });
}

type ReleaseCreation = Parameters<
  GitHubClient["rest"]["repos"]["createRelease"]
>[0];
type ReleaseUpdate = Parameters<
  GitHubClient["rest"]["repos"]["updateRelease"]
>[0];
type ReleaseAssetUpload = Parameters<
  GitHubClient["rest"]["repos"]["uploadReleaseAsset"]
>[0];

export function createRelease(
  args: ReleaseCreation & { octokit: GitHubClient },
) {
  const { octokit, ...parameters } = args;
  return octokit.rest.repos.createRelease(parameters);
}

export function getRelease(args: RepositoryContext & { releaseId: number }) {
  return args.octokit.rest.repos.getRelease({
    owner: args.owner,
    repo: args.repo,
    release_id: args.releaseId,
  });
}

export function updateRelease(args: ReleaseUpdate & { octokit: GitHubClient }) {
  const { octokit, ...parameters } = args;
  return octokit.rest.repos.updateRelease(parameters);
}

export function listReleaseAssets(
  args: RepositoryContext & { releaseId: number },
) {
  return args.octokit.paginate(args.octokit.rest.repos.listReleaseAssets, {
    owner: args.owner,
    repo: args.repo,
    release_id: args.releaseId,
    per_page: 100,
  });
}

export function getReleaseAsset(args: RepositoryContext & { assetId: number }) {
  return args.octokit.rest.repos.getReleaseAsset({
    owner: args.owner,
    repo: args.repo,
    asset_id: args.assetId,
    headers: { accept: "application/octet-stream" },
  });
}

export function deleteReleaseAsset(
  args: RepositoryContext & { assetId: number },
) {
  return args.octokit.rest.repos.deleteReleaseAsset({
    owner: args.owner,
    repo: args.repo,
    asset_id: args.assetId,
  });
}

export function uploadReleaseAsset(
  args: ReleaseAssetUpload & { octokit: GitHubClient },
) {
  const { octokit, ...parameters } = args;
  return octokit.rest.repos.uploadReleaseAsset(parameters);
}
