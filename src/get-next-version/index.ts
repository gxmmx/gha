import * as core from "@actions/core";

interface ReleasePlan {
  schema_version: 1;
  repository: string;
  source: {
    event: string;
    sha: string;
    ref: string;
    branch: string;
    pull_request: null;
  };
  configuration: {
    stable_branch: null;
    alpha_branch: null;
    beta_branch: null;
    rc_branch: null;
    version_format: "semver";
  };
  history: {
    stable_base_version: null;
  };
  decision: {
    channel: null;
    bump: null;
    reason: "unmatched-branch";
    release_required: false;
  };
  versions: {
    build_version: string;
    next_stable_version: null;
    next_release_version: null;
    next_release_tag: null;
  };
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required GitHub context value: ${name}`);
  return value;
}

function branchFromRef(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function main(): void {
  const commitSha = requiredEnvironmentValue("GITHUB_SHA");
  const repository = requiredEnvironmentValue("GITHUB_REPOSITORY");
  const ref = requiredEnvironmentValue("GITHUB_REF");
  const event = requiredEnvironmentValue("GITHUB_EVENT_NAME");
  const branch = branchFromRef(ref);
  const buildVersion = `sha-${commitSha.slice(0, 8)}`;

  const plan: ReleasePlan = {
    schema_version: 1,
    repository,
    source: { event, sha: commitSha, ref, branch, pull_request: null },
    configuration: {
      stable_branch: null,
      alpha_branch: null,
      beta_branch: null,
      rc_branch: null,
      version_format: "semver",
    },
    history: { stable_base_version: null },
    decision: {
      channel: null,
      bump: null,
      reason: "unmatched-branch",
      release_required: false,
    },
    versions: {
      build_version: buildVersion,
      next_stable_version: null,
      next_release_version: null,
      next_release_tag: null,
    },
  };

  core.setOutput("build_version", buildVersion);
  core.setOutput("next_stable_version", "");
  core.setOutput("next_release_version", "");
  core.setOutput("next_release_tag", "");
  core.setOutput("release_required", "false");
  core.setOutput("commit_sha", commitSha);
  core.setOutput("channel", "");
  core.setOutput("bump", "");
  core.setOutput("reason", "unmatched-branch");
  core.setOutput("release_plan", JSON.stringify(plan));
}

try {
  main();
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error));
}
