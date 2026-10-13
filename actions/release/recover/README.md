# Recover release attempts

Use this action from a manual workflow to resume or explicitly abandon an
existing release attempt. It never creates a release or performs registry
publication. Resume requires the recorded `attempt_id` and returns the original
plan, version profile, source SHA, notes, staged asset manifest, retained
GitHub asset URLs, and any saved registry receipt. The caller owns registry
reconciliation: query each external registry and compare its immutable digest
with the receipt before deciding whether to publish or retry. A receipt is
evidence for reconciliation; it is not proof that an external side effect should
be skipped.

Abandon requires a nonblank reason. It stores that reason in the draft's
structured attempt record and keeps both the draft and immutable full-version
tag. Abandoned attempts cannot be staged, resumed for publication, or published.
Deleting a workflow run does not change attempt state. A subsequent planner
counts every full-version tag, including tag-only claims left by an interrupted
preparation, so the same version cannot identify different source content.

```yaml
permissions:
  contents: write

steps:
  - id: recover
    uses: gxmmx/gha/actions/release/recover@main
    with:
      github_token: ${{ github.token }}
      operation: resume
      attempt_id: ${{ inputs.attempt_id }}
```

Resume only needs `contents: read`; abandonment needs `contents: write` to
update the draft. The step above shows the broader permission needed when the
same workflow supports both operations. Manual workflows should accept an
attempt ID explicitly and must not derive a new release plan before recovery.

## Inputs

| Input          | Required | Description                                  |
| -------------- | -------- | -------------------------------------------- |
| `github_token` | Yes      | Token used to read or update the release     |
| `operation`    | Yes      | `resume` or `abandon`                        |
| `attempt_id`   | Yes      | Existing attempt ID stored on a release      |
| `reason`       | Abandon  | Required explanation recorded with the draft |

## Outputs

| Output             | Description                                        |
| ------------------ | -------------------------------------------------- |
| `attempt_id`       | Durable attempt identity                           |
| `release_id`       | GitHub release ID retaining the attempt            |
| `tag`              | Immutable full-version tag                         |
| `version`          | Recorded build and release version                 |
| `source_sha`       | Exact source commit                                |
| `release_plan`     | Recorded plan and original format profile          |
| `release_notes`    | Snapshotted notes                                  |
| `asset_manifest`   | Staged asset names, sizes, and checksums           |
| `registry_receipt` | Recorded external artifact refs and digests        |
| `release_assets`   | Existing release assets with browser download URLs |
| `attempt_state`    | `draft`, `abandoned`, or `published`               |
| `abandoned_reason` | Recorded reason, or empty                          |
