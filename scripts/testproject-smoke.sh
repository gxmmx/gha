#!/usr/bin/env bash
set -euo pipefail

workflow_url="$(gh workflow run release-action-smoke.yml --repo gxmmx/testproject --ref issue/2-action-smoke)"
workflow_run_id="${workflow_url##*/}"
printf 'Started testproject smoke run: %s\n' "$workflow_url"
gh run watch "$workflow_run_id" --repo gxmmx/testproject --exit-status
