export type ReleaseChannel = "stable" | "alpha" | "beta" | "rc" | null;
export type VersionFormat = "semver" | "pep440";

export interface ChannelConfiguration {
  stableBranch: string;
  alphaBranch: string | null;
  betaBranch: string | null;
  rcBranch: string | null;
  versionFormat: VersionFormat;
}

export function resolveChannelConfiguration(args: {
  defaultBranch: string;
  stableBranchInput: string;
  alphaBranchInput: string;
  betaBranchInput: string;
  rcBranchInput: string;
  versionFormatInput: string;
}): ChannelConfiguration {
  const stableBranch = args.stableBranchInput || args.defaultBranch;
  const alphaBranch = args.alphaBranchInput || null;
  const betaBranch = args.betaBranchInput || null;
  const rcBranch = args.rcBranchInput || null;
  const versionFormat = args.versionFormatInput || "semver";

  if (versionFormat !== "semver" && versionFormat !== "pep440") {
    throw new Error(`Unsupported version_format: ${versionFormat}`);
  }

  const candidateBranches = [
    ["alpha", alphaBranch],
    ["beta", betaBranch],
    ["rc", rcBranch],
  ] as const;
  const assigned = new Map<string, string>();
  for (const [channel, branch] of candidateBranches) {
    if (!branch) continue;
    if (branch === args.defaultBranch || branch === stableBranch) {
      throw new Error(
        `Invalid channel branch configuration: ${channel} cannot use stable/default branch ${branch}`,
      );
    }
    const existing = assigned.get(branch);
    if (existing) {
      throw new Error(
        `Invalid channel branch configuration: ${existing} and ${channel} both use ${branch}`,
      );
    }
    assigned.set(branch, channel);
  }

  return {
    stableBranch,
    alphaBranch,
    betaBranch,
    rcBranch,
    versionFormat,
  };
}

export function channelForBranch(
  configuration: ChannelConfiguration,
  branch: string,
): ReleaseChannel {
  if (branch === configuration.stableBranch) return "stable";
  if (branch === configuration.alphaBranch) return "alpha";
  if (branch === configuration.betaBranch) return "beta";
  if (branch === configuration.rcBranch) return "rc";
  return null;
}
