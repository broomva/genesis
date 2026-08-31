#!/usr/bin/env bash
# shellcheck disable=SC2016
#   The mutation anchors below are LITERAL TypeScript, so `${...}` and backticks
#   must NOT expand — the single quotes are the mechanism, not an oversight.
#   File-level because it applies to every anchor, not just the first: scoped to
#   one line it silently covers nothing, which is a mistake already made once in
#   the sibling sweep.
# Mutation sweep for the D measurement (BRO-2390).
#
# WHY THIS EXISTS HERE TOO. The ticket's first DoD item is that a committed script
# regenerates the numbers, and its second is that the report states n. Both are
# claims about arithmetic that decides an architecture parameter. A percentile
# function with green tests that cannot fail is exactly the fabricated quantity
# the ticket was written to prevent — one layer up.
#
# Same four guards as scripts/mutation-sweep-walkie.sh: clean tree, green
# baseline, anchor-occurs-exactly-once, arity.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

SUITE=(scripts/duration-stats.test.ts)
SUBJECTS=(scripts/duration-stats.ts)
EXPECTED_MUTANTS=8

if [ -n "$(git -c core.fsmonitor=false status --porcelain -- "${SUBJECTS[@]}" "${SUITE[@]}")" ]; then
  echo "REFUSING: the files under test are not clean — this script reverts them between mutants."
  exit 2
fi
if ! baseline="$(bun test "${SUITE[@]}" 2>&1)"; then
  echo "REFUSING: the suite is already red, so no mutant verdict would mean anything."
  printf '%s\n' "$baseline" | grep '(fail)' | head -5 | sed 's/^/    /'
  exit 2
fi
echo "baseline green"

BAK="$(mktemp -d)"
for f in "${SUBJECTS[@]}"; do mkdir -p "$BAK/$(dirname "$f")"; cp "$f" "$BAK/$f"; done
restore() { for f in "${SUBJECTS[@]}"; do cp "$BAK/$f" "$f"; done; }
trap 'restore; rm -rf "$BAK"' EXIT

total=0; survivors=0
# mutate <label> <file> <anchor> <replacement> <expected-failing-TEST-NAME-substring>
mutate() {
  local label="$1" file="$2" anchor="$3" repl="$4" want="$5"
  total=$((total + 1))
  restore
  # COUNTED IN PYTHON, not with grep -c. grep counts matching LINES, so a
  # multi-line anchor reports the number of lines it spans and every such anchor
  # looks like a duplicate. The sibling sweep already learned this.
  local n
  n="$(python3 -c 'import sys;print(open(sys.argv[1]).read().count(sys.argv[2]))' "$file" "$anchor")"
  if [ "$n" != "1" ]; then
    echo "  ERROR     $label — anchor occurs $n times in $file, expected exactly 1"
    survivors=$((survivors + 1)); return
  fi
  python3 - "$file" "$anchor" "$repl" <<'PY'
import sys, pathlib
f, a, r = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(f); s = p.read_text()
assert s.count(a) == 1
p.write_text(s.replace(a, r, 1))
PY
  local out
  if out="$(bun test "${SUITE[@]}" 2>&1)"; then
    echo "  SURVIVED  $label"
    survivors=$((survivors + 1))
  elif printf '%s' "$out" | grep '(fail)' | grep -qF -- "$want"; then
    echo "  killed    $label"
  else
    echo "  SURVIVED  $label — red, but not via \"$want\""
    survivors=$((survivors + 1))
  fi
  restore
}

A=scripts/duration-stats.ts

echo "the percentile itself"
mutate "nearest-rank instead of interpolating" "$A" \
  '  return loV + (hiV - loV) * (rank - lo);' '  return loV;' \
  "interpolates between neighbours"
mutate "sorts the caller's array in place" "$A" \
  '  const xs = [...values].sort((a, b) => a - b);
  if (xs.length === 1) return xs[0];' \
  '  const xs = values.sort((a, b) => a - b);
  if (xs.length === 1) return xs[0];' \
  "unsorted input gives the same answer"
mutate "empty sample returns 0 instead of undefined" "$A" \
  '  if (values.length === 0) return undefined;
  if (!(p >= 0 && p <= 1))' \
  '  if (values.length === 0) return 0 as unknown as undefined;
  if (!(p >= 0 && p <= 1))' \
  "empty sample is undefined"
mutate "out-of-range p is clamped rather than refused" "$A" \
  '  if (!(p >= 0 && p <= 1)) throw new RangeError(`percentile p must be in [0,1], got ${p}`);' \
  '  p = Math.min(1, Math.max(0, p));' \
  "throws rather than extrapolating"

echo "the sufficiency guards — the ones that stop a number being invented"
mutate "the constant-sample refusal is removed" "$A" \
  '  if (s.distinct < 2) {' '  if (false) {' \
  "every observation is identical"
mutate "the too-few-above refusal is removed" "$A" \
  '  if (above < MIN_ABOVE) {' '  if (false) {' \
  "too few observations sit above"
mutate "observationsAbove counts the boundary too" "$A" \
  '  return values.filter((x) => x > v).length;' \
  '  return values.filter((x) => x >= v).length;' \
  "strict, not inclusive"

echo "coverage"
mutate "fractionUnder excludes the boundary" "$A" \
  '  return values.filter((x) => x <= ms).length / values.length;' \
  '  return values.filter((x) => x < ms).length / values.length;' \
  "boundary is inclusive"

echo
if [ "$total" -ne "$EXPECTED_MUTANTS" ]; then
  echo "$total mutants ran, expected $EXPECTED_MUTANTS — a mutant was added or removed"
  exit 1
fi
restore
if [ -n "$(git -c core.fsmonitor=false status --porcelain -- "${SUBJECTS[@]}")" ]; then
  echo "the tree was not restored cleanly:"; git -c core.fsmonitor=false status --porcelain -- "${SUBJECTS[@]}"; exit 1
fi
if [ "$survivors" -eq 0 ]; then echo "$total mutants, 0 survivors"; else echo "$total mutants, $survivors SURVIVED"; fi
exit "$((survivors > 0))"
