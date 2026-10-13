# Publish release

Use this action after the consumer has completed its registry publication. It
validates the plan and attempt saved on the matching draft, verifies that the
full version tag points to the exact source commit, stores any registry receipt
on the draft, then publishes the release. It does not publish to a registry or
decide registry idempotency.

The optional receipt is JSON with a `schema_version` of `1` and one or more
artifacts. Each artifact contains a registry name, an immutable reference, and
a SHA-256, SHA-384, or SHA-512 digest:

```json
{
  "schema_version": 1,
  "artifacts": [
    {
      "registry": "npm",
      "reference": "https://registry.npmjs.org/example/1.2.3",
      "digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ]
}
```

When supplied, the action attaches the exact JSON as `release-receipt.json`,
records it in the attempt metadata, and adds artifact references and digests to
the release notes before publishing. Repeating the same publish succeeds;
changing a recorded receipt or a staged asset fails. Releases without assets or
a receipt are supported.

Stable releases move the major-only tag (`v1`, for example) to the released
source commit after the full version is published. Set `update_major_alias:
false` to disable that behavior. Prerelease releases never move major aliases.
The chosen setting is saved on the attempt. If alias movement fails after the
release is published, rerun this action with the same attempt inputs to repair
the alias without publishing another release. A later stable publish checks
that enabled aliases for earlier stable releases still point to their recorded
source commits and stops if one needs repair. An explicit
`update_major_alias: false` on a stable attempt records that alias maintenance
is disabled for that version; this also lets the next stable release proceed
past a broken alias. To repair instead, rerun the earlier published attempt
with the default setting or `update_major_alias: true`.

Serialize the whole consumer release workflow. Put workflow-level concurrency on
the workflow that contains planning, preparation, build/registry publication,
and this final publish step. Share the same group across every workflow that can
publish releases in this repository:

```yaml
concurrency:
  group: release-${{ github.repository }}
  queue: max
```

GitHub allows at most 100 pending runs in a `queue: max` group; overflow runs
are canceled. Never use `cancel-in-progress: true`. The actions check prior
stable attempts before creating/publishing a later stable release, so a canceled
or missing predecessor must be rerun or explicitly abandoned before later
publication proceeds. Keep the group at workflow level so it covers preparation
through final publication.

```yaml
permissions:
  contents: write

steps:
  - id: publish
    uses: gxmmx/gha/actions/release/publish@main
    with:
      github_token: ${{ github.token }}
      draft_release_id: ${{ steps.prepare.outputs.draft_release_id }}
      attempt_id: ${{ steps.prepare.outputs.attempt_id }}
      release_plan: ${{ steps.prepare.outputs.release_plan }}
      registry_receipt: ${{ steps.registry.outputs.release_receipt }}
      update_major_alias: true
```

The action requires `contents: write` to verify the tag, attach the receipt,
and publish the release.

## Inputs

| Input                | Required | Description                                                 |
| -------------------- | -------- | ----------------------------------------------------------- |
| `github_token`       | Yes      | Token used to validate and publish the prepared release     |
| `draft_release_id`   | Yes      | Draft release ID returned by `prepare-release`              |
| `attempt_id`         | Yes      | Attempt ID returned by `prepare-release`                    |
| `release_plan`       | Yes      | Unmodified prepared plan returned by `prepare-release`      |
| `registry_receipt`   | No       | JSON receipt for artifacts published by the consumer        |
| `update_major_alias` | No       | Move stable `v<major>` tag after publication; defaults true |

## Outputs

| Output               | Description                                                |
| -------------------- | ---------------------------------------------------------- |
| `published`          | `true` when the matching release is published              |
| `release_id`         | Finalized GitHub release ID                                |
| `tag`                | Full version tag                                           |
| `version`            | Published release version                                  |
| `source_sha`         | Exact source commit recorded by the attempt                |
| `receipt_asset_name` | `release-receipt.json`, or empty when no receipt is stored |
