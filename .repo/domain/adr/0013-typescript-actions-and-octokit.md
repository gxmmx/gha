# Build bundled Node actions with TypeScript and Octokit

Status: accepted.

Implement public actions in TypeScript and bundle each runtime so consumers do
not need to install dependencies or select an implementation language. Share
GitHub event handling and API access through `@actions/github` and Octokit,
rather than maintaining a custom HTTP client. This keeps actions self-contained
and GitHub integration consistent while committing the project to Node-based
action runtimes.
