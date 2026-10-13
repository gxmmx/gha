# Bind versions to recoverable release attempts

Status: accepted.

Keep durable release coordination in the consumer's GitHub repository instead
of an external service. An immutable full-version reference binds a version to
one source commit; a retained draft records the attempt so retries resume the
same version, notes, and artifact bytes. Preserve machine-readable attempt data
as a release asset after publication, keeping the public description focused on
release notes and artifact references. Abandonment retains the version identity,
allowing gaps rather than assigning attempted content a new meaning.
