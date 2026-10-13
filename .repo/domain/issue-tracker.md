# Issue tracker: GitHub

Issues for this repo live in GitHub Issues for `gxmmx/gha`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. For multiline bodies, write the text to a temporary file and use `--body-file`.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Create a sub-issue**: Link it as a GitHub sub-issue.
- **Record blockers**: Use GitHub's native issue dependencies.
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Issue and pull request numbers

GitHub shares one number space across issues and pull requests. A referenced number may be a PR; check with `gh pr view <number>` and use `gh pr` commands when applicable, otherwise use `gh issue` commands.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
