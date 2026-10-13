# Contributing

Bug reports, focused fixes, and feature proposals are welcome. Please check
existing issues first. For a larger change, open a feature request before
starting implementation so the proposed behavior can be discussed.

## Set up and check your change

The project uses Node.js 24 and [mise](https://mise.jdx.dev/) to manage its
toolchain and development commands.

1. Fork and clone the repository.
2. Install the pinned toolchain and dependencies with `mise install` and
   `mise run setup`.
3. Create a branch for your change.
4. Make a focused change. Add or update behavior tests and documentation where
   appropriate.
5. Run the checks used by CI:

   ```sh
   mise run lint
   mise run typecheck
   mise run test
   mise run build
   ```

   If you change TypeScript action code, run `mise run build` and include the
   updated bundled files under `actions/**/dist/`.
6. Push your branch to your fork and open a pull request. Describe the user
   impact and list the checks you ran.

Keep pull requests focused. Changes to release planning or publication should
include tests for the affected behavior and explain how retries and
no-release cases behave.
