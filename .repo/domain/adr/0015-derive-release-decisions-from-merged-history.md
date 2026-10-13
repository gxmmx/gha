# Derive release decisions from preserved merged history

Status: accepted.

The complete conventional-commit history through the exact release commit is
the source for version changes and release notes. Release branches preserve PR
titles and commit details through squash merges; previews never authorize
publication. Explicitly configured branches select stable and prerelease
channels, and a release decision is retained for its commit and channel so
retries cannot change it. This avoids basing releases on a single PR or mutable
descriptions while keeping suppressed changes available to a later release.
Without a published stable baseline, the first release-worthy history starts at
`0.1.0`; later stable versions bump from the published stable release. Published
prereleases remain distinct historical versions after a stable release ships.
