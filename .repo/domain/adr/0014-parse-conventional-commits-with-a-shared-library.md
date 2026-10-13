# Parse Conventional Commits with a shared library

Status: accepted.

Use `conventional-commits-parser` to recognize Conventional Commit structure,
while keeping version mapping and validation policy in this project. This avoids
reimplementing the message grammar without making a parser library responsible
for release policy.
