export type VersionFormat = "semver" | "pep440";

export function parseVersionFormat(input: string): VersionFormat {
  if (input === "" || input === "semver") return "semver";
  if (input === "pep440") return "pep440";
  throw new Error(`Unsupported version_format: ${input}`);
}

export function fallbackBuildVersion(
  format: VersionFormat,
  sha: string,
  runId: number,
): string {
  return format === "pep440" ? `0.0.0.dev${runId}` : `sha-${sha.slice(0, 8)}`;
}

export function previewBuildVersion(args: {
  format: VersionFormat;
  prospectiveVersion: string | null;
  pullRequest: number;
  sha: string;
  runId: number;
}): string {
  if (args.prospectiveVersion === null) {
    return fallbackBuildVersion(args.format, args.sha, args.runId);
  }
  if (args.format === "pep440") {
    return `${args.prospectiveVersion}.dev${args.runId}`;
  }
  return `${args.prospectiveVersion}-pr.${args.pullRequest}.sha.${args.sha.slice(0, 8)}`;
}

export function canonicalStableTag(version: string | null): string | null {
  return version === null ? null : `v${version}`;
}
