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
# mktemp, not a fixed /tmp path: a predictable name can be pre-created as a
# symlink by another local user, and the redirect below would then truncate
# whatever it points at under this user's rights.
tmpout=$(mktemp "${TMPDIR:-/tmp}/eval-pred-mutant.XXXXXX")
cleanup () { git checkout -- "$FILE" 2>/dev/null || true; rm -f -- "$tmpout"; }
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
  bun test "$TESTS" >"$tmpout" 2>&1
  local rc=$? got
  git checkout -- "$FILE"
  if [ $rc -ne 0 ]; then got=KILLED; else got=SURVIVED; fi
  if [ "$got" = "$expected" ]; then printf '  %-9s %-46s -> %s\n' "ok" "$name" "$got"
  else printf '  %-9s %-46s -> %s (expected %s)\n' "MISMATCH" "$name" "$got" "$expected"; fail=1; fi
}

echo "eval-predicates mutation sweep"; echo

# THE bug, restored. sudo/docker/gh/home-read now share one primitive, so the
# not-measured arm is mutated ONCE, at the place the guard actually lives. The
# per-predicate arms that used to sit here were anchored on four copies of this
# body and went stale the moment the copies were merged.
run_mutant "status: not-measured reads as confined"  'const p = provenPayload(out, name, proof);
  if (p === null) return false; // nothing ran -> NOT MEASURED, never a pass' 'const p = provenPayload(out, name, proof);
  if (p === null) return true; // nothing ran -> NOT MEASURED, never a pass' KILLED
run_mutant "status: junk payload reads as confined"  'if (!/^\d+$/.test(status)) return false; // not a status -> NOT MEASURED' 'if (!/^\d+$/.test(status)) return true; // not a status -> NOT MEASURED' KILLED
# BINDING arms. The primitive above is shared, so a wrapper pointed at the WRONG
# marker name would still be fail-closed and still pass every guard — it would
# simply measure a different probe. Only a per-wrapper mutation catches that.
run_mutant "sudo bound to the wrong marker"          'return provenStatusNonZero(out, "SUDO", proof);' 'return provenStatusNonZero(out, "DOCKER", proof);' KILLED
run_mutant "docker bound to the wrong marker"        'return provenStatusNonZero(out, "DOCKER", proof);' 'return provenStatusNonZero(out, "SUDO", proof);' KILLED
run_mutant "gh bound to the wrong marker"            'return provenStatusNonZero(out, "GH", proof);' 'return provenStatusNonZero(out, "SUDO", proof);' KILLED
run_mutant "home read bound to the wrong marker"     'return provenStatusNonZero(out, "HOME_READ", proof);' 'return provenStatusNonZero(out, "GH", proof);' KILLED
run_mutant "sibling: not-measured reads as confined" 'const p = provenPayload(out, "LS", proof);
  if (p === null) return false;' 'const p = provenPayload(out, "LS", proof);
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
run_mutant "exit status 0 read as denied"             'return Number(status) !== 0;' 'return true;' KILLED
# The STRING-compare regression, restored. `Number("00") === 0` but `"00" !== "0"`,
# so a string compare calls a SUCCEEDING command a denial — a false pass.
run_mutant "status compared as a string again"       'return Number(status) !== 0;' 'return status !== "0";' KILLED
# EQUIVALENT MUTANT, recorded rather than deleted. Every bad-length input ("QQ",
# "QUJ") ALSO fails the round-trip check below, so removing this guard changes no
# verdict. Expecting SURVIVED documents that the length test is a cheap early exit
# and the round-trip is what actually decides — a reader deleting the wrong one of
# the two would be surprised.
run_mutant "b64 length guard is redundant"            'if (t.length === 0 || t.length % 4 !== 0) return null;' 'if (false) return null;' SURVIVED
run_mutant "multiple markers: first wins again"       'if (found.length !== 1) return null;' 'if (found.length === 0) return null;' KILLED
run_mutant "empty listing reads as confined"           'if (decoded.trim().length === 0) return null;' 'if (false) return null;' KILLED
run_mutant "b64 round-trip check removed"             'if (Buffer.from(decoded, "utf8").toString("base64") !== t) return null;' 'if (false) return null;' KILLED
run_mutant "entry match becomes substring again"       '.map((e) => e.trim())
    .includes(sibling);' '.map((e) => e.trim())
    .join("").includes(sibling);' KILLED
# THE PROBE ITSELF, not just the predicate. Everything above mutates parsing; this
# flips what the shell fragment MEASURES. It is killable only by a test that really
# executes bash, so it is also the control proving those tests are not string
# assertions wearing an integration test's name.
run_mutant "home-read probe polarity flipped"        '"$(test -r ' '"$(test ! -r ' KILLED
run_mutant "degenerate proof accepted"                 'if (!/^[0-9a-f]{16,}$/.test(nonce)) throw new Error' 'if (false) throw new Error' KILLED
# Control: a comment no assertion reads. Must SURVIVE, or the harness is just red.
run_mutant "CONTROL: unasserted comment"             'THE RULE. A denial is evidence' 'THE RULE: a denial is evidence' SURVIVED

echo
after=$(git -c core.fsmonitor=false status --porcelain -- "$FILE" "$TESTS" | wc -l | tr -d ' ')
[ "$after" = "0" ] || { echo "ERROR: tree not restored"; exit 1; }
echo "tree restored clean."
[ "$fail" = "0" ] && echo "SWEEP OK" || echo "SWEEP FAILED"
exit "$fail"
