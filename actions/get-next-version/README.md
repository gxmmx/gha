# Get next version

This bundled action reads the GitHub event context and returns a build version
and a serialized release plan. Its initial implementation handles unconfigured
branches: it returns `sha-<first eight characters of the source SHA>` and marks
the plan as non-publishable.

## Usage

```yaml
permissions: {}

steps:
  - id: version
    uses: gxmmx/gha/actions/get-next-version@main

  - run: echo "Build version: $BUILD_VERSION"
    env:
      BUILD_VERSION: ${{ steps.version.outputs.build_version }}
```

The action requires GitHub's standard `GITHUB_SHA`, `GITHUB_REPOSITORY`,
`GITHUB_REF`, and `GITHUB_EVENT_NAME` context variables. This fallback path
does not call the GitHub API and requires no repository permissions.

## Outputs

| Output                 | Unconfigured branch value                                                               |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `build_version`        | `sha-<8-character SHA>`                                                                 |
| `next_stable_version`  | Empty                                                                                   |
| `next_release_version` | Empty                                                                                   |
| `next_release_tag`     | Empty                                                                                   |
| `release_required`     | `false`                                                                                 |
| `commit_sha`           | Full source SHA                                                                         |
| `channel`              | Empty                                                                                   |
| `bump`                 | Empty                                                                                   |
| `reason`               | `unmatched-branch`                                                                      |
| `release_plan`         | JSON object with schema version, source, configuration, history, decision, and versions |

`release_plan` contains no credentials. Consumers can pass it unchanged to
subsequent release actions. An unmatched branch never authorizes publication.
