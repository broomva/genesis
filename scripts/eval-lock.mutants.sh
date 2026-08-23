#!/usr/bin/env bash
# Mutation sweep for the eval lock (BRO-2245).
#
# WHY THIS IS COMMITTED. A mutation result quoted in a PR body and a mutation
# result quoted from memory render identically. Cross-model review flagged the
# first version of this work for exactly that: the sweep was "absent from the
# artifact". This file makes the claim regenerable — run it and read the table.
#
#   bash scripts/eval-lock.mutants.sh
#
# The load-bearing arm is `wx -> w`. That single character is the entire mutual
# exclusion guarantee: with O_EXCL the kernel serialises the create, without it
# every racer overwrites and proceeds. If that arm ever SURVIVES, the concurrency
# test has stopped testing concurrency and the guard is decorative.
#
# There is also a deliberate SURVIVE control. A sweep that reports only KILLs
# cannot distinguish "the tests are strong" from "the harness always reports red"
# — the control is what separates them.

set -uo pipefail
cd "$(dirname "$0")/.."

FILE=scripts/eval-lock.ts
TESTS=scripts/eval-lock.test.ts

dirty=$(git -c core.fsmonitor=false status --porcelain -- "$FILE" "$TESTS" | wc -l | tr -d ' ')
if [ "$dirty" != "0" ]; then
  echo "ABORT: $FILE / $TESTS have uncommitted changes."
  echo "This script reverts with 'git checkout --', which would DESTROY them."
  exit 1
fi

fail=0

run_mutant () {
  local name="$1" from="$2" to="$3" expected="$4"
  local n
  n=$(grep -cF -- "$from" "$FILE")
  if [ "$n" != "1" ]; then
    printf '  %-8s %-42s (anchor appears %s times, expected 1 — stale mutant)\n' "SKIP" "$name" "$n"
    fail=1
    return
  fi

  python3 - "$FILE" "$from" "$to" <<'PY'
import sys
path, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
assert s.count(a) == 1, "anchor not unique at mutation time"
open(path, "w").write(s.replace(a, b))
PY

  bun test "$TESTS" >/tmp/eval-lock-mutant.out 2>&1
  local rc=$?
  git checkout -- "$FILE"

  local got
  if [ $rc -ne 0 ]; then got=KILLED; else got=SURVIVED; fi
  if [ "$got" = "$expected" ]; then
    printf '  %-8s %-42s -> %s\n' "ok" "$name" "$got"
  else
    printf '  %-8s %-42s -> %s (expected %s)\n' "MISMATCH" "$name" "$got" "$expected"
    fail=1
  fi
}

echo "eval-lock mutation sweep"
echo

# THE one that matters: drop O_EXCL and exclusion is gone.
# Anchored on the full options object: the bare string `flag: "wx"` also appears
# in this file's header comment, and the uniqueness guard correctly refused to run
# an ambiguous mutant rather than silently patching prose and reporting SURVIVED.
run_mutant "wx -> w (drops O_EXCL)"        '{ flag: "wx", mode: 0o644 }'        '{ flag: "w", mode: 0o644 }'         KILLED
run_mutant "EPERM read as dead"            '=== "EPERM"'                        '=== "ESRCH"'                        KILLED
run_mutant "release ignores ownership"     'if (held?.nonce !== record.nonce) return false;' 'if (false) return false;' KILLED
run_mutant "never yields to a live holder" 'if (!alive(record.pid)) return false;' 'if (alive(record.pid)) return false;' KILLED
run_mutant "max-age disabled (pid reuse)"  'return nowMs - started < maxAgeMs;'  'return true;'                       KILLED
# Control: prose no assertion reads. Must SURVIVE, or the harness is just red.
run_mutant "CONTROL: unasserted prose"     'Wait for the running eval'          'Please wait for the running eval'   SURVIVED

echo
after=$(git -c core.fsmonitor=false status --porcelain -- "$FILE" "$TESTS" | wc -l | tr -d ' ')
if [ "$after" != "0" ]; then
  echo "ERROR: tree not restored — $FILE / $TESTS still modified."
  exit 1
fi
echo "tree restored clean."
[ "$fail" = "0" ] && echo "SWEEP OK" || echo "SWEEP FAILED"
exit "$fail"
