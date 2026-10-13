# Stage release assets

This action validates project files and attaches them to the draft release
attempt created by `prepare-release`. Run it after project build steps and
before registry publication or final GitHub release publication. Every
nonblank `assets` line is a required checkout-relative path or glob pattern;
each line must match at least one regular file before the draft is changed.

For supplied files, the action uploads the files and a generated `SHA256SUMS`
asset. It records names, sizes, and SHA-256 digests in the attempt metadata on
the draft. Retries can complete a partially uploaded set when GitHub reports
the same SHA-256 digests. A retry with a changed file set or different bytes
fails. Existing draft assets that are not recorded by this attempt also fail.
File basenames must be unique because GitHub release assets have flat names;
`SHA256SUMS` is reserved for the generated checksum file.

Asset-free attempts need no placeholder file. The action accepts an empty
`assets` input and records an empty manifest without uploading an asset.

```yaml
permissions:
  contents: write

steps:
  - id: stage
    uses: gxmmx/gha/actions/release/stage-assets@main
    with:
      github_token: ${{ github.token }}
      draft_release_id: ${{ steps.prepare.outputs.draft_release_id }}
      attempt_id: ${{ steps.prepare.outputs.attempt_id }}
      assets: |
        dist/*.tar.gz
        dist/checksums.txt
```

The action requires `contents: write` to update the draft and upload its
assets. It reads files from the current consumer checkout.

## Inputs

| Input              | Required | Description                                                         |
| ------------------ | -------- | ------------------------------------------------------------------- |
| `github_token`     | Yes      | Token used to read and update the draft release and upload assets   |
| `draft_release_id` | Yes      | Draft release ID returned by `prepare-release`                      |
| `attempt_id`       | Yes      | Attempt ID returned by `prepare-release`                            |
| `assets`           | No       | Newline-separated checkout-relative paths or required glob patterns |

## Outputs

| Output           | Description                                                          |
| ---------------- | -------------------------------------------------------------------- |
| `staged`         | `true` after staging completes, including for an empty asset set     |
| `asset_names`    | JSON array of uploaded names, including `SHA256SUMS` when applicable |
| `asset_manifest` | JSON names, sizes, and SHA-256 digests for files and checksums       |
| `checksum_asset` | `SHA256SUMS`, or empty when no files were supplied                   |
