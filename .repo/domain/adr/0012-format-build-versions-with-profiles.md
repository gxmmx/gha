# Format build versions with predefined profiles

Status: accepted.

Offer fixed `semver` and `pep440` profiles for ecosystem build identifiers while
keeping release tags in canonical SemVer. Persist the selected profile with a
release attempt so retries keep the same build identity. Fixed profiles cover
the supported packaging needs without introducing consumer-defined templates
that could alter release semantics.
