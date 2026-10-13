# gha

Reusable GitHub Actions and workflows for planning and publishing versioned
GitHub releases.

## Use the release workflow

For a simple GitHub-only release, call the reusable workflow from your
repository:

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
    uses: gxmmx/gha/.github/workflows/release.yml@v0
    with:
      stable_branch: main
```

The workflow checks pull requests for release eligibility and publishes a
GitHub release after an eligible change reaches the configured branch. It does
not build or publish project artifacts. For inputs, outputs, permissions,
channels, and retry behavior, see the [workflow guide](.github/workflows/release.md).

Use `@v0` for the current stable major version, or pin a full commit SHA when
you need an immutable reference.

## Available components

| Component | Purpose |
| --- | --- |
| [Get next version](actions/get-next-version/README.md) | Plan a stable or prerelease version without writing to GitHub. |
| [Prepare release](actions/release/prepare-release/README.md) | Validate a release decision, claim its version, and create a draft. |
| [Stage release assets](actions/release/stage-assets/README.md) | Validate and attach project files to a draft release. |
| [Publish release](actions/release/publish/README.md) | Record artifact references and publish a prepared release. |
| [Recover release attempt](actions/release/recover/README.md) | Resume or explicitly abandon an existing release attempt. |
| [Minimal release workflow](.github/workflows/release.md) | Compose the planner, preparation, and publisher for GitHub-only releases. |

Projects that build or publish artifacts can compose the actions around their
own build and registry steps. Each action guide documents its inputs, outputs,
permissions, and consumer usage.

## Repository layout

```text
actions/             Reusable action definitions and bundled entry points
.github/workflows/   CI, reusable release workflow, and this repo's release workflow
src/                 TypeScript action implementations
test/                Action behavior tests
```

## Development

See [Contributing](CONTRIBUTING.md) for setup and checks. This project is
licensed under the [MIT License](LICENSE).
