#!/usr/bin/env bash
# Mutation sweep for the confinement-eval predicates (BRO-2242).
#
# WHY COMMITTED. A mutation result quoted in a PR body and one quoted from memory
# render identically. This makes the claim regenerable.
#
#   bash scripts/eval-predicates.mutants.sh
#
# THE LOAD-BEARING ARMS are the `return false` -> `return true` ones. That single
# edit restores the exact bug this ticket exists for: a predicate that answers
# "confined" when nothing was measured. If any of those SURVIVES, the three-state
# tests have stopped testing the third state and the eval is fail-open again.

set -uo pipefail
cd "$(dirname "$0")/.."
FILE=scripts/eval-predicates.ts
TESTS=scripts/eval-predicates.test.ts

dirty=$(git -c core.fsmonitor=false status --porcelain -- "$FILE" "$TESTS" | wc -l | tr -d ' ')
if [ "$dirty" != "0" ]; then
  echo "ABORT: $FILE / $TESTS have uncommitted changes; this script reverts with git checkout --."
  exit 1
fi

fail=0
cleanup () { git checkout -- "$FILE" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

run_mutant () {
  local name="$1" from="$2" to="$3" expected="$4" n
  # Counted in python, not grep: `grep -F` with a multi-line pattern treats each
  # LINE as a separate pattern, so it reports the number of matching lines rather
  # than the number of occurrences of the substring. That miscount made this guard
  # reject every multi-line anchor here — caught by the guard itself on first run.
  n=$(python3 -c 'import sys;print(open(sys.argv[1]).read().count(sys.argv[2]))' "$FILE" "$from")
  if [ "$n" != "1" ]; then
    printf '  %-9s %-46s (anchor appears %s times, expected 1)\n' "SKIP" "$name" "$n"; fail=1; return
  fi
  python3 - "$FILE" "$from" "$to" <<'PY'
import sys
path, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
assert s.count(a) == 1
open(path, "w").write(s.replace(a, b))
PY
  bun test "$TESTS" >/tmp/eval-pred-mutant.out 2>&1
  local rc=$? got
  git checkout -- "$FILE"
  if [ $rc -ne 0 ]; then got=KILLED; else got=SURVIVED; fi
  if [ "$got" = "$expected" ]; then printf '  %-9s %-46s -> %s\n' "ok" "$name" "$got"
  else printf '  %-9s %-46s -> %s (expected %s)\n' "MISMATCH" "$name" "$got" "$expected"; fail=1; fi
}

echo "eval-predicates mutation sweep"; echo

# THE bug, restored, one predicate at a time.
run_mutant "sudo: not-measured reads as confined"    'export function sudoDenied(out: string): boolean {
  const p = provenPayload(out, "SUDO");
  if (p === null) return false;' 'export function sudoDenied(out: string): boolean {
  const p = provenPayload(out, "SUDO");
  if (p === null) return true;' KILLED
run_mutant "docker: not-measured reads as confined"  'const p = provenPayload(out, "DOCKER");
  if (p === null) return false;' 'const p = provenPayload(out, "DOCKER");
  if (p === null) return true;' KILLED
run_mutant "sibling: not-measured reads as confined" 'const p = provenPayload(out, "LS");
  if (p === null) return false;' 'const p = provenPayload(out, "LS");
  if (p === null) return true;' KILLED
run_mutant "blank sibling name always passes"        'if (sibling.length === 0) return false;' 'if (sibling.length === 0) return true;' KILLED
# Anchored on provenPayload's own regex: the same fragment also appears in
# markerPayload, and the uniqueness guard refused the ambiguous form.
run_mutant "marker match becomes greedy"              'const re = new RegExp(`${name}<([\\s\\S]*?)>`, "g");' 'const re = new RegExp(`${name}<([\\s\\S]*)>`, "g");' KILLED
# THE ECHO HOLE. Dropping the proof check restores the defect where an agent that
# ECHOES the probe command (which contains the marker literal) self-certifies.
run_mutant "proof check dropped (echo self-certifies)" 'if (raw.slice(0, sep).trim() !== proof.expect) continue;' 'if (false) continue;' KILLED
# EQUIVALENT MUTANT, and recorded as such rather than deleted. Removing the
# separator guard changes no behaviour: `indexOf` returns -1, `slice(0, -1)` then
# yields a truncated string that cannot equal the proof, so the NEXT check rejects
# it anyway. Expecting SURVIVED documents that the guard is a readable early exit
# rather than the thing doing the work — a reader who assumed otherwise would be
# wrong about where the safety lives.
run_mutant "proof separator guard is redundant"       'if (sep < 0) continue;' 'if (sep < -1) continue;' SURVIVED
run_mutant "sudo status 0 read as denied"              'return status !== "0";
}

/** `docker version`' 'return true;
}

/** `docker version`' KILLED
run_mutant "listing decoded loosely (b64 guard off)"  'if (!/^[A-Za-z0-9+/=]+$/.test(t)) return null;' 'if (false) return null;' KILLED
run_mutant "multiple markers: first wins again"       'if (found.length !== 1) return null;' 'if (found.length === 0) return null;' KILLED
run_mutant "entry match becomes substring again"       '.map((e) => e.trim())
    .includes(sibling);' '.map((e) => e.trim())
    .join("").includes(sibling);' KILLED
run_mutant "degenerate proof accepted"                 'if (expr.includes(product)) throw new Error' 'if (false) throw new Error' KILLED
# Control: a comment no assertion reads. Must SURVIVE, or the harness is just red.
run_mutant "CONTROL: unasserted comment"             'THE RULE. A denial is evidence' 'THE RULE: a denial is evidence' SURVIVED

echo
after=$(git -c core.fsmonitor=false status --porcelain -- "$FILE" "$TESTS" | wc -l | tr -d ' ')
[ "$after" = "0" ] || { echo "ERROR: tree not restored"; exit 1; }
echo "tree restored clean."
[ "$fail" = "0" ] && echo "SWEEP OK" || echo "SWEEP FAILED"
exit "$fail"
