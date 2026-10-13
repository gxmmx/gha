# GitHub release behavior experiment

Date: 2026-10-13  
Repository: [`gxmmx/testproject`](https://github.com/gxmmx/testproject)  
Issue: [#3](https://github.com/gxmmx/gha/issues/3)

All generated names used the `gxgha-issue3-` prefix. No stable or prerelease was
published.

## Drafts and version claims

- Creating draft release [411732021](https://github.com/gxmmx/testproject/releases)
  for nonexistent tag `gxgha-issue3-draft-20261013` did not create
  `refs/tags/gxgha-issue3-draft-20261013`. GitHub returned an `untagged-*` URL
  while retaining the requested `tag_name`. A second simultaneous draft
  ([411732207](https://github.com/gxmmx/testproject/releases)) with that same
  `tag_name` was accepted. Drafts therefore do not reserve a version.
- Supplying a commit SHA as `target_commitish` was rejected (HTTP 422); using
  `main` succeeded. The draft API response identifies `main`, not the resolved
  source SHA. An attempt record must preserve exact source identity separately.
- A manually created tag ref did reject a second create-ref request for the same
  name (HTTP 422, “Reference already exists”). Deleting its draft left that
  ref intact. After deleting a draft with no tag ref, creating another draft
  with the same `tag_name` also succeeded (IDs 411741240 then 411741360).
- A retained draft remains listable as an ordinary draft record; GitHub does
  not distinguish an abandoned attempt. Deleting drafts and the namespaced tag
  succeeded. This confirms ADR-0005's warning: draft visibility is not an
  atomic claim. Git tag refs are unique, but a draft cannot safely provide that
  coordination boundary by itself.

## Commit status after workflow deletion

Workflow run [38409006951](https://github.com/gxmmx/testproject/actions/runs/38409006951)
completed on SHA `d49300105bc64ac02813974e7a33ce9aa04d78a5`. I attached status
`gxgha/issue-3/release-decision/stable` (status ID `56229826680`) with that run
URL, deleted the run, and verified the status still appeared from the commit
statuses API with the same ID, context, state, and URL. The run endpoint then
returned 404. GitHub exposes no usable delete operation for this status through
the tested API; the uniquely namespaced status remains on the test commit as
historical evidence.

## Squash title and commit details

Repository settings report `squash_merge_commit_title=PR_TITLE` and
`squash_merge_commit_message=COMMIT_MESSAGES`. Disposable PR [#1](https://github.com/gxmmx/testproject/pull/1)
was squash-merged into a temporary target branch. Its title was
`feat(probe): inspect squash details`; the squash commit
[`e47b1c92e5e3934ce9b4a345a81c1cb6f8ba0f4f`](https://github.com/gxmmx/testproject/commit/e47b1c92e5e3934ce9b4a345a81c1cb6f8ba0f4f)
used that PR title and preserved both source commit messages in its body,
including `feat(probe): demonstrate title severity`,
`fix(probe): second conventional detail`, and
`BREAKING CHANGE: disposable probe changes this interface.` The temporary
target/source branches were deleted; the merged PR remains as the experiment
record.

## Workflow concurrency

The disposable workflow used concurrency group `gxgha-issue3-queue-probe`,
`queue: max`, and `cancel-in-progress: false`, with a 45-second hold. Runs
[38409388405](https://github.com/gxmmx/testproject/actions/runs/38409388405),
[38409393597](https://github.com/gxmmx/testproject/actions/runs/38409393597),
and
[38409398430](https://github.com/gxmmx/testproject/actions/runs/38409398430)
were dispatched in that order. One ran while two remained pending. Canceling
the active run released the next queued run; the third then ran. Manually
rerunning the canceled run queued it behind those runs and it succeeded as
attempt 2. The observed order matched queue arrival order in this sample.

GitHub's [concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
specifies up to 100 pending runs with `queue: max`; later arrivals are canceled.
It also says processing is FIFO by when each run starts waiting, while actual
wait-start time can vary, so dispatch order is not guaranteed. The experiment
verified the configuration, multi-run queueing, cancellation, and manual rerun,
but did not load-test all 100 pending slots. Release predecessor checks remain
necessary: a queued workflow cannot guarantee event order. The probe did not
exercise a release-specific out-of-order failure because testproject has no
release-attempt workflow to run.

## Cleanup and limits

Draft releases, disposable tag refs, and temporary workflow/squash branches were
deleted. The workflow runs remain in Actions history; PR #1 and squash commit
remain as historical test evidence. The namespaced commit status is retained
because the tested API did not support deleting it. No consumer workflow change
was retained in the testproject worktree.

The full 100-pending queue limit is based on GitHub's published contract, not a
101-run stress test. Status persistence was tested with a status created via the
GitHub API and linked to a workflow run; it was not written by an action's
`GITHUB_TOKEN` during that run. No permissions blocker prevented these tests.
