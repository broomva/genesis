#!/usr/bin/env bash
# The predicate behind the one required status check.
#
# It lives here, not inline in ci.yml, for one reason: inline it could not be
# tested. The P20 round-2 review gutted the whole step to
# `run: echo "all gates succeeded"` and neither `bun test` nor the mutation sweep
# noticed — the single context branch protection names could be reduced to a
# no-op with every check in the repo still reporting success. That is the same
# defect class this repo exists to close, sitting in the job that gates merges.
#
# Reads the `needs` context as JSON on stdin or in $NEEDS. Exits 0 only when
# every dependency reports `success`.
#
# `skipped` is a failure here, deliberately: GitHub counts a SKIPPED required
# check as PASSING, so anything that is not an outright success has to be
# treated as one. `!= "success"` rather than `== "failure"` is what makes that
# true, and test/gates-predicate.test.ts pins it.
set -euo pipefail

needs="${NEEDS:-$(cat)}"

if ! printf '%s' "$needs" | jq -e . >/dev/null 2>&1; then
  echo "::error::the needs context was not valid JSON"
  exit 1
fi

count="$(printf '%s' "$needs" | jq 'length')"
if [ "$count" -eq 0 ]; then
  # An empty needs object means this job has no dependencies at all, which for
  # an aggregate whose whole purpose is aggregating is a misconfiguration, not
  # a pass. test/workflow-gates.test.ts is what keeps the list correct; this
  # only refuses the degenerate case.
  echo "::error::the aggregate has no dependencies — it is gating on nothing"
  exit 1
fi

bad="$(printf '%s' "$needs" | jq -r 'to_entries[] | select(.value.result != "success") | "\(.key)=\(.value.result)"')"
if [ -n "$bad" ]; then
  echo "::error::gates did not succeed:"
  printf '%s\n' "$bad"
  exit 1
fi

echo "all $count gates succeeded"
