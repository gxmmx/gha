import type { ReleaseChannel } from "./channels.js";
import type { VersionFormat } from "./version-profile.js";

export type CandidateChannel = Exclude<ReleaseChannel, "stable" | null>;

const stableSemver = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const candidateSemver =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(alpha|beta|rc)\.([1-9]\d*)$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseStableSemver(version: string): ParsedVersion | null {
  const match = stableSemver.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function parseCandidateTag(
  tag: string,
): { base: string; channel: CandidateChannel; counter: number } | null {
  const match = candidateSemver.exec(tag);
  if (!match) return null;
  return {
    base: `${match[1]}.${match[2]}.${match[3]}`,
    channel: match[4] as CandidateChannel,
    counter: Number(match[5]),
  };
}

export function compareStableVersions(left: string, right: string): number {
  const a = parseStableSemver(left);
  const b = parseStableSemver(right);
  if (!a || !b) throw new Error("Cannot compare invalid stable versions");
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function canonicalCandidateTag(
  version: string,
  channel: CandidateChannel,
  counter: number,
): string {
  return `v${version}-${channel}.${counter}`;
}

export function formatCandidateVersion(
  version: string,
  channel: CandidateChannel,
  counter: number,
  format: VersionFormat,
): string {
  if (format === "semver") return `${version}-${channel}.${counter}`;
  const suffix = channel === "alpha" ? "a" : channel === "beta" ? "b" : "rc";
  return `${version}${suffix}${counter}`;
}

export function formatStableVersion(
  version: string,
  _format: VersionFormat,
): string {
  return version;
}
