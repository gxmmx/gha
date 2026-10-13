# Repository instructions

## Project

`gxmmx/gha` is a public repository of reusable GitHub Actions and workflows.

The sibling `testproject` repository is the consumer used to test release behavior.
The sibling `semreleasetest` repository contains an earlier release experiment
and serves as reference material.

## Development

Keep shared actions and workflows in this repository. Test their behavior from
`testproject` before adopting them in application repositories.

Each action has its own directory and `action.yml`. Reusable workflows live
directly under `.github/workflows/` and expose `workflow_call`.

Keep implementation changes scoped to the relevant action or workflow. Document
its inputs, outputs, required permissions, and consumer usage. Verify release
planning, no-release behavior, and reruns when changing release logic.

Keep wording precise and concise.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `gxmmx/gha`. See `.repo/domain/issue-tracker.md`.

### Status labels

GX skills use five canonical status labels. See `.repo/domain/status-labels.md`.

### Domain docs

Domain vocabulary and decisions live under `.repo/domain/`. See `.repo/domain/domain.md`.
