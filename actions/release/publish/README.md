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
```

The action requires `contents: write` to verify the tag, attach the receipt,
and publish the release.

## Inputs

| Input              | Required | Description                                             |
| ------------------ | -------- | ------------------------------------------------------- |
| `github_token`     | Yes      | Token used to validate and publish the prepared release |
| `draft_release_id` | Yes      | Draft release ID returned by `prepare-release`          |
| `attempt_id`       | Yes      | Attempt ID returned by `prepare-release`                |
| `release_plan`     | Yes      | Unmodified prepared plan returned by `prepare-release`  |
| `registry_receipt` | No       | JSON receipt for artifacts published by the consumer    |

## Outputs

| Output               | Description                                                |
| -------------------- | ---------------------------------------------------------- |
| `published`          | `true` when the matching release is published              |
| `release_id`         | Finalized GitHub release ID                                |
| `tag`                | Full version tag                                           |
| `version`            | Published release version                                  |
| `source_sha`         | Exact source commit recorded by the attempt                |
| `receipt_asset_name` | `release-receipt.json`, or empty when no receipt is stored |
