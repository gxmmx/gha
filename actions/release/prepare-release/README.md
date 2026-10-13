# Prepare release

This action validates pull requests targeting configured release branches and
normalizes their titles from the strongest commit signal. On a release branch
push, it verifies that `GITHUB_SHA` is the exact squash commit of one merged PR,
records the channel decision, claims the selected version, and creates a draft
release before consumer build jobs run.

## Release attempts

For a release decision, pass the unmodified `release_plan` output from
`get-next-version`. Preparation validates the repository, event, run, source
SHA, target branch, resolved channel configuration, and release decision. A
stale plan fails before the version claim is created.

Preparation creates `refs/tags/<next_release_tag>` at the exact pushed SHA
before creating the draft. GitHub accepts duplicate drafts and does not create a
tag when a draft names a nonexistent tag, so the tag ref is the atomic version
claim. The draft stores the source SHA, version, resolved plan, attempt ID, and
release notes. A retry finds that draft and reuses its saved plan and notes. The
planner also returns that recorded plan after publication, so rerunning the push
reuses the same release ID, version, and tag. If a run stops after creating the
tag but before creating the draft, a retry can finish the attempt only when the
existing tag points to the same source SHA. A different source or plan fails
closed. Deleting a draft does not free the tag.

Notes are generated from the unreleased conventional commit history through the
exact pushed SHA. Breaking changes, features, and fixes are grouped, and repeated
squash summaries are removed. The associated merged PR's optional `## Release
notes` section is appended. Extraction stops at the next level-one or level-two
heading. Once the attempt exists, later PR edits do not change its notes.

For stable pushes, preparation also checks every tracked predecessor commit
since the stable baseline. Each must have a successful stable decision snapshot;
release decisions must have a published or explicitly abandoned attempt. A
missing snapshot or unresolved attempt stops preparation before it creates a
draft, so later runs cannot silently skip work after cancellation or queue
overflow. Rerun the predecessor workflow to finish it, or abandon its existing
attempt with a reason through `release/recover`.

```yaml
permissions:
  contents: write
  pull-requests: read
  statuses: write

steps:
  - id: plan
    uses: gxmmx/gha/actions/get-next-version@main
    with:
      github_token: ${{ github.token }}
  - id: prepare
    uses: gxmmx/gha/actions/release/prepare-release@main
    with:
      github_token: ${{ github.token }}
      release_plan: ${{ steps.plan.outputs.release_plan }}
```

Planner and preparation branch and version-format inputs must match. Push runs
need `contents: write`, `pull-requests: read`, and `statuses: write`. PR runs
need `contents: read`; title normalization also needs `pull-requests: write`.
Do not pass a privileged token to untrusted PR code.

The stable branch defaults to the repository default branch. Alpha, beta, and RC
branches are disabled unless configured. An unconfigured target is a successful
no-op. Stable PRs require a release-worthy change by default; set
`require_release: false` to opt out, or apply the configurable `no_release_label`
(default `no-release`). The label suppresses publication for every configured
channel. Malformed Conventional Commit-like messages and incomplete histories
fail before builds. Ordinary non-conventional messages are neutral.

## Inputs

| Input              | Required | Description                                                                |
| ------------------ | -------- | -------------------------------------------------------------------------- |
| `github_token`     | Yes      | Token for GitHub API; push attempts require contents and statuses write    |
| `stable_branch`    | No       | Stable branch; defaults to the repository default branch                   |
| `alpha_branch`     | No       | Alpha branch; empty disables the channel                                   |
| `beta_branch`      | No       | Beta branch; empty disables the channel                                    |
| `rc_branch`        | No       | RC branch; empty disables the channel                                      |
| `require_release`  | No       | Require release signal on stable PRs; defaults to `true`                   |
| `no_release_label` | No       | Suppression label; defaults to `no-release`                                |
| `release_plan`     | Push     | Unmodified planner output for the same push; required for release attempts |

## Outputs

| Output               | Description                                                      |
| -------------------- | ---------------------------------------------------------------- |
| `prepared`           | Whether preparation ran for a configured target                  |
| `reason`             | `release`, `no-changes`, `suppressed`, or `unmatched-branch`     |
| `title`              | Normalized PR title, or original title for an unmatched target   |
| `title_updated`      | Whether title normalization succeeded or was already current     |
| `title_update_error` | Missing title write permission details, if applicable            |
| `bump`               | `none`, `patch`, `minor`, or `major`                             |
| `channel`            | `stable`, `alpha`, `beta`, `rc`, or empty                        |
| `release_required`   | Whether an unsuppressed release signal exists                    |
| `pull_request`       | PR number from GitHub event context                              |
| `decision_sha`       | Exact squash SHA with a recorded push decision; empty on PR runs |
| `decision_context`   | Channel-specific commit status context; empty on PR runs         |
| `attempt_id`         | Durable identity stored in the draft attempt                     |
| `draft_release_id`   | GitHub release ID of the draft                                   |
| `release_notes`      | Notes snapshotted at draft creation                              |
| `release_plan`       | Validated plan with `attempt_id` added                           |
