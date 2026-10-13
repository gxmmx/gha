# Get next version

This bundled, read-only action resolves the stable branch, reads the exact source
commit history, and returns a version prediction with a serialized release plan.
It inspects all commits after the latest reachable stable release. Before
the first stable release, the base version is `0.1.0`.

## Usage

```yaml
permissions:
  contents: read
  pull-requests: read
  statuses: read

steps:
  - id: version
    uses: gxmmx/gha/actions/get-next-version@main
    with:
      github_token: ${{ github.token }}
      version_format: pep440

  - run: echo "Build version: $BUILD_VERSION"
    env:
      BUILD_VERSION: ${{ steps.version.outputs.build_version }}
```

`github_token` is required and needs `contents: read`, `pull-requests: read`, and
`statuses: read`. The planner does not write to GitHub. `stable_branch` is
optional and defaults to the repository's default branch. `version_format` is
optional and accepts `semver` (default) or `pep440`. Pull request runs use the
PR head SHA and base branch. PR previews include the PR number and short head
SHA under SemVer, or the workflow run ID under PEP 440. They never authorize
release publication. Other branches use the profile's fallback build version.

## Inputs

| Input            | Required | Description                                                      |
| ---------------- | -------- | ---------------------------------------------------------------- |
| `github_token`   | Yes      | Read token with `contents`, `pull-requests`, and `statuses` read |
| `stable_branch`  | No       | Stable branch; defaults to the repository default branch         |
| `version_format` | No       | `semver` (default) or `pep440` build version profile             |

## Outputs

| Output                 | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `build_version`        | Version for this build; SHA fallback when no stable version exists |
| `next_stable_version`  | Prospective stable base version, or empty                          |
| `next_release_version` | Proposed version for a release, or empty                           |
| `next_release_tag`     | Canonical `v<version>` tag for a release, or empty                 |
| `release_required`     | `true` only for release branch pushes with a bump                  |
| `commit_sha`           | Full source SHA                                                    |
| `channel`              | `stable` on the stable branch, otherwise empty                     |
| `bump`                 | `none`, `patch`, `minor`, or `major`                               |
| `reason`               | `release`, `preview`, `no-changes`, or `unmatched-branch`          |
| `release_plan`         | Version 1 JSON plan; contains no credentials                       |

The planner maps `fix` to patch, `feat` to minor, and breaking changes to major.
Ordinary messages are neutral; malformed Conventional Commit-like messages fail
planning. Pull request runs use the PR head SHA and base branch, return a
provisional preview version when a prospective stable version is available, and
leave `next_release_version` and `next_release_tag` empty. With no prospective
version, SemVer uses `sha-<short-sha>` and PEP 440 uses `0.0.0.dev<run-id>`.
Git tags always use canonical SemVer (`v<version>`), regardless of the selected
profile. Consumers can pass `release_plan` unchanged to later release actions.
An unmatched branch never authorizes publication.
