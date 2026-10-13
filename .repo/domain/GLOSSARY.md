# Release automation

Shared language for planning, building, and publishing releases.

## Language

**Release commit**:
The exact commit whose content a release identifies.
_Avoid_: Latest commit, current branch head

**Target branch**:
The branch that selects the release channel for a pull request or push.
_Avoid_: Source branch

**Release channel**:
A configured stream of stable or prerelease versions, such as stable, alpha,
beta, or RC.
_Avoid_: Branch name, version format

**Build version**:
The version identifier assigned to a build; it does not by itself authorize
publication.
_Avoid_: Published version

**Stable base version**:
The proposed stable version before any prerelease or preview suffix.
_Avoid_: Candidate number, preview identifier

**Stable release**:
A published release with no prerelease suffix.
_Avoid_: Preview build, release candidate

**Published prerelease**:
A published alpha, beta, or RC version intended for consumers before a stable
release. It remains a distinct historical version after a stable release ships.
_Avoid_: PR build, disposable preview

**Preview build**:
A build produced before publication for testing, identified by its source
revision.
_Avoid_: Release candidate, stable release

**PR preparation**:
Validation and normalization of a pull request before merge. It does not claim
a version or publish a release.
_Avoid_: Release attempt, release publication

**Release decision**:
The decision for a release commit and channel about whether its changes may be
published.
_Avoid_: Version prediction

**Release attempt**:
An effort to publish a particular version from a particular release commit. A
retry continues the same attempt.
_Avoid_: Workflow run

**Abandoned attempt**:
A release attempt explicitly stopped while retaining its version and source
identity.
_Avoid_: Deleted run, successful release

**Version claim**:
The association between a version and its release commit, which prevents that
version from identifying different content.
_Avoid_: PR prediction, preview identifier

**Major alias**:
A moving major-only version reference, such as `v1` pointing to the latest
applicable stable release.
_Avoid_: Exact version tag, prerelease channel

**Release suppression**:
A deliberate decision to skip publication for a merge while retaining its
changes in the unreleased history.
_Avoid_: No release-worthy changes, failed publication

**Version format profile**:
A predefined representation of build versions for an ecosystem. It does not
change the identity of a release.
_Avoid_: Release channel, version bump policy
