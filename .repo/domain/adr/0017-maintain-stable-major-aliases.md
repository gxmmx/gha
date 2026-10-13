# Maintain stable major aliases after publication

Status: accepted.

After a stable release, move its major-only tag (such as `v1`) to the released
commit by default; full-version tags remain immutable, and prereleases do not
move major aliases. If alias movement fails after publication, retry the same
attempt to repair it before allowing later stable publication. This gives
consumers a convenient compatible-version reference while preserving exact
version references for reproducible use.
