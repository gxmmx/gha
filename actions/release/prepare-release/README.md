# Prepare release

This action checks every commit in a pull request targeting a configured release
branch, derives the strongest release signal, and normalizes the PR title while
preserving its description and scope. It must run before build jobs that depend
on a valid release decision.

On a push to a configured release branch, it verifies that `GITHUB_SHA` is the
exact squash commit of one merged PR targeting that branch. It snapshots the
PR's release or suppression decision in a successful commit status on that SHA,
using `gha/release-decision/stable`, `.../alpha`, `.../beta`, or `.../rc`.
Retries reuse the recorded status and do not re-read labels or create another
status. Direct pushes, ambiguous PR matches, and SHA mismatches fail before the
status is created. Suppressed commits remain in Git history; the read-only
version planner continues to include them in later release ranges.

Push runs need `contents: read`, `pull-requests: read`, and `statuses: write`.
PR runs need `contents: read`, `pull-requests: read`, and `pull-requests: write`
when title normalization is enabled. The action creates no release draft.

```yaml
permissions:
  contents: read
  pull-requests: write

steps:
  - id: prepare
    uses: gxmmx/gha/actions/release/prepare-release@main
    with:
      github_token: ${{ github.token }}
      no_release_label: no-release
```

`github_token` needs `contents: read` and `pull-requests: read`; title
normalization also needs `pull-requests: write`. If the API denies the title
update, the action emits `title_updated=false` and an explanatory
`title_update_error`, while retaining successful read-only validation. This is
expected for many fork PRs. Do not pass a privileged token to untrusted PR code.

The stable branch defaults to the repository default branch. Alpha, beta, and
RC branches are disabled unless configured. An unconfigured target is a
successful no-op. Stable PRs require a release-worthy change by default; set
`require_release: false` to opt out, or apply the configurable `no_release_label`
(default `no-release`). The label suppresses publication for every configured
channel. Malformed Conventional Commit-like messages and incomplete histories
fail before builds. Ordinary non-conventional messages are neutral.

## Inputs

| Input              | Required | Description                                                                     |
| ------------------ | -------- | ------------------------------------------------------------------------------- |
| `github_token`     | Yes      | Token with repository read access; add `pull-requests: write` for title updates |
| `stable_branch`    | No       | Stable branch; defaults to the repository default branch                        |
| `alpha_branch`     | No       | Alpha branch; empty disables the channel                                        |
| `beta_branch`      | No       | Beta branch; empty disables the channel                                         |
| `rc_branch`        | No       | RC branch; empty disables the channel                                           |
| `require_release`  | No       | Require release signal on stable PRs; defaults to `true`                        |
| `no_release_label` | No       | Suppression label; defaults to `no-release`                                     |

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
| `pull_request`       | PR number from event context                                     |
| `decision_sha`       | Exact squash SHA with a recorded push decision; empty on PR runs |
| `decision_context`   | Channel-specific commit status context; empty on PR runs         |
