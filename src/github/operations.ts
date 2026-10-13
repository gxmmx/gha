import * as github from "@actions/github";

export type GitHubClient = ReturnType<typeof github.getOctokit>;

export interface GitHubOperations {
  octokit: GitHubClient;
  owner: string;
  repo: string;
}

export function createGitHubOperations(token: string): GitHubOperations {
  const context = github.context;
  return {
    octokit: github.getOctokit(token, { baseUrl: context.apiUrl }),
    owner: context.repo.owner,
    repo: context.repo.repo,
  };
}

export async function listRepositoryReleases(args: {
  octokit: GitHubClient;
  owner: string;
  repo: string;
}) {
  return args.octokit.paginate(args.octokit.rest.repos.listReleases, {
    owner: args.owner,
    repo: args.repo,
    per_page: 100,
  });
}
