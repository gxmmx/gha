# Compose shared release operations around consumer-owned pipelines

Status: accepted.

Shared actions own release planning, GitHub release state, and publication;
consumers own tests, builds, and registry integrations. A reusable workflow
composes the simple GitHub-only path, while projects with custom artifacts
compose the same actions around their own jobs. This keeps release rules
consistent without imposing one build or registry system on every consumer.
