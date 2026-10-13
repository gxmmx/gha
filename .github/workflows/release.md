# Minimal release workflow

Call `/.github/workflows/release.yml` from a consumer workflow to validate
pull requests targeting a configured release branch and publish asset-free
GitHub releases when eligible commits land. The called workflow runs only the
shared planner, preparation, and publisher actions. It does not run consumer
tests, builds, container publishing, or registry publication. Projects that
need these steps can compose the actions directly and stage their own release
assets.

## Consumer workflow

```yaml
name: Release

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write
  statuses: write

jobs:
  release:
    uses: gxmmx/gha/.github/workflows/release.yml@v1
    with:
      stable_branch: main
      # Optional channels are disabled when omitted.
      # alpha_branch: alpha
      # beta_branch: beta
      # rc_branch: release-candidate
      version_format: semver
      require_release: true
      no_release_label: no-release
      update_major_tag: true
```

Omit `stable_branch` to use the repository's default branch. Set
`update_major_tag: false` to leave stable major-only aliases unchanged.
Prerelease publications do not move those aliases.

The called workflow accepts only `pull_request` and `push` events. Pull request
runs prepare and validate configured release targets and never publish. An
unconfigured PR target completes as a no-op. Push runs prepare the exact pushed
commit, require it to match a merged pull request, then publish only when the
saved decision permits a release. A suppressed or unmatched push does not
publish.

## Inputs

| Input | Type | Default | Description |
| --- | --- | --- | --- |
| `stable_branch` | string | repository default branch | Stable release target; empty selects the default branch |
| `alpha_branch` | string | empty | Alpha release branch; empty disables the channel |
| `beta_branch` | string | empty | Beta release branch; empty disables the channel |
| `rc_branch` | string | empty | RC release branch; empty disables the channel |
| `version_format` | string | `semver` | Build version profile (`semver` or `pep440`) |
| `require_release` | boolean | `true` | Require release-worthy changes on stable-target PRs |
| `no_release_label` | string | `no-release` | Label that suppresses publication for a merged PR |
| `update_major_tag` | boolean | `true` | Update the stable `v<major>` alias after publication |

## Outputs

| Output | Description |
| --- | --- |
| `build_version` | Planned build version for this event |
| `release_required` | Whether the saved PR or commit decision permits a release |
| `reason` | `release`, `suppressed`, `no-changes`, or `unmatched-branch` |
| `attempt_id` | Durable release attempt identity, empty when no attempt exists |
| `version` | Published version, empty when no release was published |
| `tag` | Published full version tag, empty when no release was published |
| `release_id` | Published GitHub release ID, empty when no release was published |

## Permissions and serialization

The caller grants the reusable workflow's maximum token permissions:
`contents: write`, `pull-requests: write`, and `statuses: write`. The workflow
uses repository contents and status writes for version claims, draft creation,
and publication; pull request writes allow title normalization. Fork PR tokens
may be read-only, in which case GitHub prevents title updates.

The reusable workflow holds `release-${{ github.repository }}` across planning,
preparation, and publication with GitHub's bounded `queue: max`. Do not enable
`cancel-in-progress`. Every other workflow that can publish stable releases in
the repository must use the same group. GitHub permits at most 100 pending runs
in a queue; overflow runs are canceled. The release actions also validate
predecessors so an earlier canceled or unresolved stable attempt blocks later
publication until it is resolved.

For custom builds and registry publication, keep one matching workflow-level
concurrency group around planning, preparation, consumer build/publication, and
the final publish action. Follow the same permission and predecessor rules.
