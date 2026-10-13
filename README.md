# gha

Reusable GitHub Actions and workflows.

## Contributor tasks

The repository pins its Node.js toolchain and npm dependencies. With mise
installed, `mise run setup` installs dependencies; `mise run lint`,
`mise run typecheck`, `mise run test`, and `mise run build` run the same checks
used by CI. `mise run smoke` dispatches the public-action smoke workflow in the
sibling `testproject` repository and waits for its result. The smoke workflow
uses the `issue/2-tooling-smoke` gha branch and `issue/2-action-smoke`
testproject branch, so both branches must be available on GitHub.

See [Get next version](actions/get-next-version/README.md) for the current
consumer action contract.
