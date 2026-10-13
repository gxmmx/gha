# Compose conventional-commit release channels and publication attempts

Status: accepted design direction. Policies below are agreed; concrete interfaces
and GitHub behavior experiments remain. No actions or workflows are implemented.

This record consolidates the design decisions detailed in ADR-0001 through
ADR-0010 and ADR-0012, keeping project-owned builds separate from shared release operations.

## Purpose

Provide composable GitHub Actions for conventional-commit releases, including
version prediction before builds, stable and candidate publication, fixed-artifact
recovery, release assets, and major aliases. All coordination stays in the consumer's
GitHub repository. The consumer owns its builds and registry integrations.

## Agreed lifecycle

Public action paths are grouped under `actions/release/`: `get-next-version`,
`prepare-release`, `stage-release`, `publish`, and `recover`. The logical `release`
operation below is exposed as `actions/release/publish` to avoid repeating the
release directory name.

| Operation          | PR execution                                                                      | Release-branch execution                                                        |
| ------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `get_next_version` | Read-only provisional version and validation                                      | Read-only release prediction; no reservation                                    |
| `prepare_release`  | Normalize title from strongest commit signal; validate available history and plan | Snapshot decision, validate available history and plan, establish draft attempt |
| `stage_release`    | Not used for release publication                                                  | Attach assets and checksums before external publication                         |
| `publish`          | Never publishes                                                                   | Validate prepared attempt; publish draft; update major alias                    |
| Recovery operation | Not an ordinary PR step                                                           | Resume or explicitly abandon an attempt; resolve optional alias step            |

PR flow: preparation → prediction → checks/tests → optional preview builds.

Release flow: prediction → preparation → project builds → staging → project
registry publication → GitHub publication → stable major alias.

Preparation must still record a suppression decision when prediction says no
release is required. It must not be skipped solely on the planner's boolean output.
Suppressed and unmatched executions create no publication draft.

The consumer holds one release concurrency group across planning through final
publication, with GitHub's `queue: max` and cancellation disabled. GitHub permits up
to 100 pending runs; additional runs are canceled. Queue order is based on when a
run starts waiting and is not guaranteed to match event dispatch order. Therefore,
each run checks earlier release commits before publication. An out-of-order run
fails closed until earlier commits are resolved and must then be rerun; canceled
runs also require recovery. Concurrency prevents simultaneous execution but does not replace
persistent predecessor checks after a workflow ends. See [GitHub concurrency
documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

## Branches and execution context

- `stable_branch` defaults to the repository's GitHub default branch.
- Explicit `alpha_branch`, `beta_branch`, and `rc_branch` select prerelease
  channels; empty disables each one.
- Channel overlaps are errors; the repository default branch cannot be a prerelease channel.
- `target_branch` is the PR base branch or pushed branch, separate from source SHA.
- PR mode, number, target branch, and source SHA are automatically discovered from
  GitHub's event context and APIs; callers do not need to pass ordinary event data.
- In PR context, `commit_sha` is the PR head SHA used in the preview identifier.
  GitHub's temporary test-merge SHA is not the preview's source identity. After a
  merge, branch workflows use the actual pushed commit SHA, including the squash
  commit on a release branch.
- PR builds never publish releases, regardless of target branch.
- Unconfigured branches use the selected profile's fallback build identifier.
- Release branches require PRs and squash merging with the title-and-commit-details
  message default. No direct pushes. Correct repository settings are user-owned
  prerequisites; actions do not inspect them on every run.
- Candidate branches must incorporate the latest stable history before publishing.

## Version calculation

Analyze the full unreleased range through the exact target SHA, including every
squash commit's preserved conventional details. Do not analyze only the latest PR.
Use the strongest conventional signal: fix → patch, feat → minor, breaking → major.
Messages that appear to use Conventional Commit syntax but are malformed fail
preparation. Ordinary messages without that syntax are neutral.
When no stable release exists, the first release-worthy history plans `0.1.0`
regardless of its strongest Conventional Commit signal; the initial signal does
not bump a synthetic baseline. After a stable release exists, calculate the next
version from that published version using the strongest unreleased signal. A
later breaking change can advance pre-v1 releases to `1.0.0`.

Stable versions exclude prerelease suffixes. Alpha, beta, and RC sequences are
independent per stable base and channel: `1.4.1-alpha.1`, `1.4.1-beta.1`,
`1.4.1-rc.1`, etc. New candidate commits advance the applicable counter, including
test/docs changes when the full range already contains a release-worthy change.
A retry reuses an existing attempt.

Conventional changes determine a minimum version; occupied claims advance stable
allocation to the next unused patch, and prerelease allocation to the next counter.
Abandoned versions are not reused for different content. Published prereleases
remain after stable publication.

All channels calculate the stable base from the last applicable successful stable
release. Candidate tags determine channel counters and retries, but do not consume
changes needed for the eventual stable bump or notes. Preserved history must survive
squash merges through alpha, beta, RC, and stable branches.

## Preview identifiers and planning outputs

`version_format` selects predefined `semver` (default) or `pep440` build rendering,
with no arbitrary templates initially. Git tags retain canonical SemVer formatting.
RC tag `v1.5.0-rc.3` accompanies version `1.5.0rc3` under `pep440`; alpha uses
`1.5.0-alpha.3` and `1.5.0a3`, respectively.

PR previews render as `1.5.0-pr.42.sha.abc12345` or `1.5.0.devN`, respectively.
N is the originating workflow run ID, retained on retries; chronological upgrade
ordering is not promised. Without an applicable base, use the short SHA under
the `semver` profile or `0.0.0.devN` under `pep440`. Malformed configuration and
operational failures are errors, not fallbacks. Full source identity is separate.
Attempts retain the profile and resolved build version for recovery.

Expose `build_version`, `next_stable_version`, `next_release_version`,
`next_release_tag`, `release_required`, full `commit_sha`, `channel`, `bump`,
`reason`, and `release_plan`. `build_version` is always populated on successful
planning. For a proposed release, `next_release_version` equals `build_version`
in the selected profile. PR executions leave `next_release_version` and
`next_release_tag` empty. `next_stable_version` is the prospective stable base.
Final publication consumes a prepared plan and attempt identity, not just a
version.
`bump` values are `none`, `patch`, `minor`, or `major`. `reason` values are
`release`, `preview`, `suppressed`, `no-changes`, or `unmatched-branch`.
Operational and validation failures fail the action; they are not reason values.
The plan's field groups are specified below.

Pass a JSON `release_plan` between actions, containing resolved configuration,
source identity, and the prediction. Preparation validates it and returns the
authoritative prepared plan, plus `attempt_id` when an attempt exists. Also expose
individual version and decision outputs so consumer build steps do not need to
parse JSON. The `next_*` names distinguish prospective values from already-published
versions; predictions become authoritative only when preparation establishes an attempt.

The plan is serialized JSON in a GitHub Actions string output/input. Consumers
pass it unchanged between actions and use direct version outputs for build steps.
They may inspect it for diagnostics but do not edit it. Actions validate its
schema, event context, source commit, and attempt identity.

The version-1 plan groups fields under `schema_version`, `repository`, `source`,
`configuration`, `history`, `decision`, and `versions`. `repository` identifies
owner and name. `source` records event, workflow run, source SHA, target branch,
and PR number when applicable. `configuration` contains resolved branches and
policy. `history` identifies the stable release baseline used. `decision` contains
channel, bump, reason, and `release_required`. `versions` contains
`build_version`, `next_stable_version`, `next_release_version`, and
`next_release_tag`. Preparation adds `attempt_id` when an attempt exists. Tokens
and credentials are excluded. Exact optional/null conventions can be finalized
with the implementation's JSON schema.

Preparation rejects a supplied prediction if its source SHA, execution context,
or resolved configuration no longer matches; callers must plan again. Once an
attempt exists, recovery reuses its recorded version, configuration, and artifacts
rather than replacing them with a fresh prediction.

Policy inputs are `require_release` (default true for stable-targeting PR
validation), `no_release_label` (default `no-release`), and `update_major_tag`
(default true). Validation policy does not itself suppress publication.

GitHub API actions take an explicit `github_token` input. The caller grants only
the permissions needed for that action; credentials are never included in the
JSON release plan. Fork PR title updates may use a separately supplied trusted
write token.

Initial token permission contract, following GitHub API scopes:

| Action                        | Required repository permissions                                 |
| ----------------------------- | --------------------------------------------------------------- |
| `get-next-version`            | `contents: read`, `pull-requests: read`, `statuses: read`       |
| `prepare-release` on PR       | `contents: read`, `pull-requests: write` to normalize the title |
| `prepare-release` after merge | `contents: write`, `pull-requests: read`, `statuses: write`     |
| `stage-release`               | `contents: write`                                               |
| `publish`                     | `contents: write`                                               |
| `recover`                     | `contents: write`, `statuses: write`                            |

These are per-action minimums; workflows may grant a combined permission set at
the job level when several actions run in the same job. Fork PRs generally cannot
receive pull-request write permission through `GITHUB_TOKEN`.

## PR preparation and release notes

Every preparation invocation normalizes the title from current commit messages,
including after manual edits. Preserve the description and scope while using the
strongest conventional identifier. A later manually changed squash title cannot
weaken a stronger signal preserved in its commit details.

Updating a PR title requires a token with pull-request write permission. Fork PR
workflows commonly receive a read-only `GITHUB_TOKEN`; without a supplied trusted
write token, preparation reports title normalization as unavailable. Read-only
planning and checks can still run. Do not elevate token permissions by running
untrusted PR code in a privileged context.

PR preparation applies only to PRs targeting configured release branches. For an
unconfigured target, preparation returns a successful no-op without changing the
title; prediction still supplies the selected profile's fallback build identifier.

Do not inject managed blocks into the PR body. Generate conventional release notes
from preserved history, grouping breaking changes, features, and fixes without
duplicating squash summaries and constituent changes. Optionally append content
under `## Release notes` from associated PRs, stopping at the next heading of equal
or higher level. Missing or empty sections add nothing; prose does not affect bumps.
Snapshot additional notes when the publication attempt is created.

## Suppression

Strict stable PR validation requires a release-worthy change by default, with a
configurable opt-out. The configurable `no-release` label permits no-bump merges
and explicitly suppresses publication even for release-worthy changes. It applies
to stable, beta, and RC channels; suppressed builds use the selected fallback.
Suppressed executions return `release_required: false` and empty
`next_release_version` and `next_release_tag`. Their `build_version` is the short
SHA under `semver`, or `0.0.0.devN` under `pep440`, using the originating run ID.

Suppression defers only that merge's publication. All its changes remain in the
next applicable release range and notes. An otherwise suppressed breaking change
must still cause a major bump when later released.

Preparation snapshots the decision on the actual target-branch squash SHA using
channel-specific commit-status contexts, such as `gha/release-decision/stable`.
Retries reuse the decision, and there is no operation to supersede it. Label edits
before merge rerun PR validation. Post-processing edits do not silently change
retries. Suppressed changes remain in the unreleased history and are included in
a later release.
Status persistence after originating run deletion requires verification.

## Attempts and assets

A draft records the exact source SHA, version, plan, release notes, and attempt
progress. Draft uniqueness, reservation behavior, and tag timing are not established
and must be tested before depending on them.

Assets are project-specific and optional. Proposed input: newline-separated paths
or patterns relative to the checkout. Every supplied path must exist and every
required pattern must match before draft publication; validate before external
publication as well. Stage files and checksums on the draft. Reuse existing staged
bytes on retry; conflicting replacements fail. Containers follow the same identity
rule with recorded image digests. Projects own how they retain/reuse image content.

Consumers reconcile existing external publication and signal success through their
workflow's required jobs. The GitHub publisher does not implement arbitrary registry
transactions and runs only after all required publication succeeds.

After project-owned registry publication succeeds, the consumer passes a JSON
receipt with artifact references and immutable digests to `publish`. This receipt
is informational: it adds links and references to the GitHub release and does not
decide whether a registry artifact should be published. The publisher stores it as
`release-receipt.json` on the draft before publication; `recover` returns it.

Each project-owned publish step handles its own idempotency. It retries transient
errors internally where possible, checks whether the exact version/artifact already
exists, skips when the existing artifact matches the intended content, publishes
when absent, and fails on a conflicting artifact. If a workflow stops after an
external publish but before saving the receipt, the consumer checks the registry
and reconciles the result before retrying. The receipt does not replace that check.

## Failure and recovery

New release publication is permitted only for a push on a configured release
branch when that exact pushed commit is the squash commit of a merged PR. A direct
push without a matching merged PR fails before publication. PR executions may
plan and build previews but cannot publish; manual executions may recover an
existing attempt but cannot create a new release.

The `actions/release/recover` interface takes an explicit `operation` and
`attempt_id` for attempt recovery. Initial attempt operations are `resume` and
`abandon`; abandonment requires a reason. Resume restores the recorded plan and
staged assets for the caller's pipeline, rather than executing project-specific
registry publication itself. Abandonment retains the draft and version claim.

- Retry completes the same attempt at the same SHA with the same claimed version.
- An unrecoverable attempt can be explicitly abandoned with a recorded reason.
- Retain the abandoned draft; later commits can release accumulated changes.
- Run deletion is cleanup, not abandonment or permission to reuse a version.
- A partially published version remains bound to its original source and content.
- Earlier unfinished stable attempts block later stable publication until resolved.
- Failed registry requests can have succeeded remotely; consumers must reconcile
  remote content rather than blindly overwrite or assume publication never happened.

Major aliases update by default after successful stable publication, with an opt-out.
Full version tags never move; prerelease versions do not move stable aliases. An alias
failure leaves publication complete but repair pending; retries repair only the
alias and later stable publication remains blocked until repaired or disabled.
The same rule maintains `v0`; publishing `v1.0.0` starts `v1` and leaves `v0` at
the last 0.x release. Moving aliases are not exact-version pins.

## Minimal reusable workflow

Expose a `workflow_call` workflow directly under `.github/workflows/`. When called
for a PR targeting a configured release branch, it prepares the title and validates
release eligibility without publishing. When called for a push to a configured
release branch, it validates the matching merged PR and publishes the GitHub
release. It does not run project-specific tests or builds. Its initial scope is
asset-free: generate notes and publish the GitHub release. Complex projects compose
individual actions around their own jobs, establishing the attempt before building
and staging assets. The initial reusable workflow does not download caller-provided
build artifacts.

It exposes the shared policy inputs: `stable_branch` (empty means the GitHub
default branch), optional `alpha_branch`, `beta_branch`, and `rc_branch` (empty
disables each), `version_format` (`semver` default), `require_release` (`true`),
`no_release_label` (`no-release`), and `update_major_tag` (`true`).

## Remaining design frontier

- Verify draft/tag behavior and commit-status persistence in the test repository
  before relying on those GitHub semantics.

See the preceding ADRs for individual decision rationale and
`.repo/testing/release-test-matrix.md` for proposed verification. Resolve these
remaining decisions and confirm shared understanding before implementation.
