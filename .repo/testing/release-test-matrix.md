# Release flow test matrix

Status: unit tests and testproject acceptance ran on 2026-10-13. The acceptance
branch and workflow runs below exercise the initial stable release, subsequent
bump, published retries, legacy attempt records, and draft retries. Use sibling
`testproject` for integration experiments and `semreleasetest` as reference only.
Separate read-only planning tests from publication tests.

## Spec 19 acceptance evidence

| Scenario | Observed behavior | Evidence |
| --- | --- | --- |
| First stable release from feature history with no applicable stable baseline | Published `v0.1.0`; exact merged SHA `3042939d4f92bb68d0a9a2b8517252ab71a563ee`; reader-facing body; verified attempt asset | testproject [PR #30](https://github.com/gxmmx/testproject/pull/30), [run 38441839703](https://github.com/gxmmx/testproject/actions/runs/38441839703) |
| Normal bump after published `v0.1.0` | Published `v0.1.1` from a fix; exact merged SHA `fb5ef72f83dd7c8b76406558d5e5a9b45a566a55`; clean body and verified asset | testproject [PR #31](https://github.com/gxmmx/testproject/pull/31), [run 38442280791](https://github.com/gxmmx/testproject/actions/runs/38442280791) |
| Retry after successful publication | Rerun attempt 2 succeeded; release list still contains one `v0.1.0`; asset-backed metadata matched the attempt | [run 38441839703](https://github.com/gxmmx/testproject/actions/runs/38441839703) |
| Draft preparation retry | Two prepares and a workflow rerun reused attempt `v0.4.0-beta.1@2c2f62102c27` and release ID `411959637`; release remained a draft with its body record | testproject [PR #32](https://github.com/gxmmx/testproject/pull/32), [run 38442917609](https://github.com/gxmmx/testproject/actions/runs/38442917609) |
| Legacy body-embedded record | Planner successfully used the `issue14-stable-target` history containing published `v0.3.0` with a body record and no attempt asset; the candidate draft was created from that baseline | [run 38442917609](https://github.com/gxmmx/testproject/actions/runs/38442917609), legacy [v0.3.0 release](https://github.com/gxmmx/testproject/releases/tag/v0.3.0) |
| Conflicting published identity and unrelated records | Same-source tag/version/plan/duplicate-record conflicts fail closed; unrelated source records are skipped | `test/get-next-version.test.cjs`; `npm test` passed 78 tests |

## GitHub feasibility experiments first

| Experiment                                | Evidence required                                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Draft for a nonexistent version tag       | Whether and when the version Git ref appears; exact target SHA                                                               |
| Two drafts for the same version           | Conflict behavior and whether drafts actually provide reservation                                                            |
| Draft delete/recreate and abandoned draft | Whether version claims survive and remain discoverable                                                                       |
| Commit-status decision and run deletion   | Snapshot can still be read for the target SHA afterward                                                                      |
| Squash title plus commit details          | Preserved multiline conventional and breaking messages, including nested candidate squash history                            |
| Concurrent release runs                   | Queue preserves up to 100 pending; no concurrent publication; out-of-order runs block on predecessors; canceled runs recover |

Do not assume reservation atomicity from draft visibility. If the experiment fails,
return to the design discussion before selecting another coordination mechanism.

## Planner and preparation

| Case                                                       | Expected behavior                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| No prior stable release with release-worthy history        | First stable version is `0.1.0`, regardless of signal                                  |
| Existing stable release with fix, feature, breaking change | Patch, minor, major bump from the published version                                    |
| No prior stable release and no release-worthy changes      | No release; do not publish `0.1.0`                                                     |
| Multiple signals                                           | Strongest preserved signal wins                                                        |
| Malformed Conventional Commit-looking message              | Preparation fails before draft creation or builds                                      |
| Ordinary non-Conventional message                          | Neutral; no bump signal                                                                |
| Suppressed breaking PR then ordinary fix                   | Later release includes both and bumps major                                            |
| Multiple squashed PRs since stable                         | Entire range analyzed, not only newest PR                                              |
| PR targeting stable/beta/RC                                | Provisional build ID; never publishable release version                                |
| Omitted stable branch                                      | Resolve repository default branch                                                      |
| Empty candidate inputs/unmatched branch                    | Disable candidates / profile fallback                                                  |
| Default branch assigned to beta or RC                      | Configuration error                                                                    |
| Overlapping channel branches                               | Configuration error                                                                    |
| Unsupported version profile/invalid context                | Defined validation error; no silent operational fallback                               |
| Planner result reason and bump                             | Values stay within the documented enums; invalid history fails the action              |
| SemVer and PEP 440 stable/beta/RC                          | Build and next release versions match selected profile; Git tag retains SemVer         |
| PR version outputs                                         | Build version populated; next release version/tag empty                                |
| PEP 440 PR preview and retry                               | Numeric dev identifier uses originating run ID; retry retains it                       |
| PEP 440 without prospective version                        | Valid `0.0.0.devN` fallback                                                            |
| Attempt resumed with changed format setting                | Original recorded build version/profile retained                                       |
| Eight-character SHA/full identity                          | Display format does not weaken exact source identity                                   |
| PR title escalation, demotion, manual edit                 | Preparation recomputes current strongest signal                                        |
| Missing/malformed preserved squash details                 | Preparation fails before draft creation or builds                                      |
| Missing action token permission                            | Fail with the required permission named before mutation                                |
| Direct push without matching merged PR                     | Fail before release publication                                                        |
| Manual trigger for new release                             | Reject; manual recovery of an existing attempt remains available                       |
| PR preparation for unconfigured target                     | Successful no-op; title unchanged; planner provides fallback build identifier          |
| Edited squash title                                        | Stronger preserved details still govern                                                |
| Notes section missing/empty/nested headings                | Correct bounded extraction and no version effect                                       |
| Notes edited after attempt starts                          | Retry uses original snapshot                                                           |
| No-bump stable PR                                          | Strict failure unless opt-out or suppression label                                     |
| Suppression on each channel                                | No publication; exact squash SHA snapshot                                              |
| Suppressed build outputs                                   | Profile fallback build version; release required false; next release version/tag empty |
| Prediction with changed SHA/context/configuration          | Preparation rejects stale plan; caller replans                                         |
| Existing attempt recovery                                  | Retain recorded version, configuration, and artifacts                                  |
| Suppression label removed after snapshot                   | Retry remains suppressed; later release includes the squash commit's changes           |
| Non-PR execution                                           | No PR format expansion or PR title mutation                                            |
| PR head versus test-merge versus actual squash SHA         | PR version uses head SHA; merged release uses exact squash SHA                         |

## Candidates and claims

| Case                                     | Expected behavior                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| Alpha/beta/RC progression                | Independent counters per channel/base; correct SemVer and PEP 440 rendering |
| Candidate docs/test commit after feature | Same base, next counter                                                     |
| Candidate rerun                          | Existing attempt/version reused                                             |
| Candidate behind stable                  | Error until branch incorporates latest stable history                       |
| Beta → RC → stable via squash            | Preserve release signal and complete stable-range notes                     |
| Abandoned stable claim                   | Next safe unused patch without losing required bump                         |
| Abandoned candidate claim                | Next unused channel counter                                                 |
| Stable published after many candidates   | Keep all published candidates/tags                                          |

## Publication and recovery

| Case                                                       | Expected behavior                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Asset-free release                                         | Valid successful publication                                                               |
| Draft retry before publication                             | Reuse the body-embedded attempt record and keep the same version and source SHA            |
| Attempt asset saved before promotion                       | Save and verify complete `gxmmx-release-attempt.json` before publishing                    |
| Attempt asset upload fails                                 | Stop before promotion; leave the release as a draft                                        |
| Attempt asset differs from the draft record                | Stop before promotion; do not publish conflicting attempt data                             |
| Published release description                              | Contains reader-facing notes and artifact references only; no attempt marker or JSON       |
| Same-source retry after publication                        | Read the attempt asset; do not publish again; allow idempotent alias repair                |
| Conflicting published attempt identity                     | Fail closed on a conflicting tag, version, source SHA, or attempt record                   |
| Existing published release with body-embedded attempt data | Continue reading the legacy body record for retry, history, and alias repair               |
| Missing path/empty required pattern                        | Fail before final publication and before external publication                              |
| Existing asset with same checksum                          | Reuse staged bytes                                                                         |
| Existing asset with different checksum                     | Fail; do not replace claimed content                                                       |
| External publish timeout after remote acceptance           | Consumer retries/reconciles idempotently; no duplicate/overwrite                           |
| Existing registry artifact matches intended content        | Consumer skips publish and supplies receipt                                                |
| Existing registry artifact conflicts with intended content | Consumer fails; never overwrites                                                           |
| Successful registry publish followed by workflow failure   | Save informational links/digests to draft before GitHub publication; recovery returns them |
| Failure before receipt is saved                            | Consumer reconciles registry before retry; receipt does not control publish skipping       |
| Interrupted draft/asset/registry/tag/release stages        | Same attempt resumes safely                                                                |
| Published GitHub release, alias failure                    | Retry alias only; no new version                                                           |
| Alias default/disabled/beta/RC                             | Stable aliases update by default; opt-out respected; candidates do not move them           |
| Abandonment with reason                                    | Retain draft/version claim; later accumulated release allowed                              |
| Abandonment without reason                                 | Reject operation                                                                           |
| Resume by attempt ID                                       | Restore recorded plan and staged assets for consumer pipeline                              |
| Delete failed run                                          | Does not silently abandon/reuse claimed version                                            |
| Later stable merge while predecessor unresolved            | Remains blocked until recovery/abandonment                                                 |
| Final action receives mismatched plan/SHA/version          | Fail before publication                                                                    |
| Final tag                                                  | Exact merged source SHA; no generated follow-up source commit                              |

## Consumers

Verify an asset-free minimal workflow and a custom pipeline with staged binary
assets plus a container publication step. Verify configured branch/merge requirements,
label-edit events, authentication boundaries, and fork PR behavior once those
interfaces are agreed. Successful integration must use the same actions a real
consumer references, rather than only invoking internal helpers locally.
