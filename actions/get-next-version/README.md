# Get next version

This bundled, read-only action resolves the stable branch, reads the exact source
commit history, and returns a stable or candidate version prediction with a
serialized release plan. It inspects all commits after the latest stable release.
When no stable release exists, the first release-worthy history plans `0.1.0`
regardless of whether its strongest signal is a fix, feature, or breaking change.
After a stable release exists, normal bump rules apply from that published version.

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

  - run: echo "Build version: $BUILD_VERSION"
    env:
      BUILD_VERSION: ${{ steps.version.outputs.build_version }}
```

`github_token` is required and needs `contents: read`, `pull-requests: read`, and
`statuses: read`. The planner does not write to GitHub. `stable_branch` is
optional and defaults to the repository's default branch. Alpha, beta, and RC
branches are opt-in. Pull request runs use the PR head SHA and base branch. Other
unconfigured branches return a short-SHA fallback and cannot authorize
publication.

## Inputs

| Input              | Required | Description                                                      |
| ------------------ | -------- | ---------------------------------------------------------------- |
| `github_token`     | Yes      | Read token with `contents`, `pull-requests`, and `statuses` read |
| `stable_branch`    | No       | Stable branch; defaults to the repository default branch         |
| `alpha_branch`     | No       | Alpha candidate branch; empty disables the channel               |
| `beta_branch`      | No       | Beta candidate branch; empty disables the channel                |
| `rc_branch`        | No       | RC candidate branch; empty disables the channel                  |
| `version_format`   | No       | `semver` (default) or `pep440` version profile                   |
| `no_release_label` | No       | Label that suppresses publication; defaults to `no-release`      |

## Outputs

| Output                 | Description                                                             |
| ---------------------- | ----------------------------------------------------------------------- |
| `build_version`        | Version for this build; SHA fallback when no stable version exists      |
| `next_stable_version`  | Prospective stable base version, or empty                               |
| `next_release_version` | Proposed version for a release, or empty                                |
| `next_release_tag`     | Canonical SemVer tag for a release, or empty                            |
| `release_required`     | `true` only for configured release branch pushes with a bump            |
| `commit_sha`           | Full source SHA                                                         |
| `channel`              | `stable`, `alpha`, `beta`, `rc`, or empty for an unconfigured branch    |
| `bump`                 | `none`, `patch`, `minor`, or `major`                                    |
| `reason`               | `release`, `preview`, `no-changes`, `suppressed`, or `unmatched-branch` |
| `release_plan`         | Version 1 JSON plan; contains no credentials                            |

The planner maps `fix` to patch, `feat` to minor, and breaking changes to major.
Ordinary messages are neutral; malformed Conventional Commit-like messages fail
planning. Pull request runs use the PR head SHA and base branch, return a
provisional stable version when available, and leave `next_release_version` and
`next_release_tag` empty. Consumers can pass `release_plan` unchanged to later
release actions. SemVer PR previews include the PR number and short SHA; PEP 440
previews use the workflow run ID. An unmatched branch never authorizes
publication.

For configured push branches, a successful recorded release-decision status is
authoritative on retries. Before preparation records that status, a configured
`no_release_label` on the exact merged PR suppresses the plan. Suppressed plans
have `release_required: false` and empty release version and tag outputs;
`build_version` still follows the selected profile.

Candidate counters are independent for each channel and prospective stable
version. Candidate Git tags always use SemVer; `version_format: pep440` renders
candidate outputs as `aN`, `bN`, or `rcN`. A candidate branch must contain the
latest successful stable release. The repository default branch cannot be a
candidate branch, and candidate branch assignments cannot overlap.

The planner also reads full-version Git tags as durable claims. Stable planning
advances the required bump to the next unused patch when another source already
owns the proposed tag. Candidate planning skips claimed channel counters. For
either channel, a release attempt recorded on a draft or published release takes
precedence over a recalculated plan for the same source SHA and configuration.
This preserves the selected version when a run is retried after the stable
baseline has advanced or after creating the tag but before creating the draft.
