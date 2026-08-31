#!/usr/bin/env bash
# Mutation sweep for the ask log and the walkie routes (BRO-2387).
#
# WHY THIS IS COMMITTED. The PR that added these tests claimed "15 mutants, 0
# survivors". That claim was made from a script in /tmp — reproducible by nobody,
# including its author on a different machine. A number in a commit message that
# no one else can regenerate is the same shape as a comment asserting an
# invariant nothing enforces, which is a defect class this ticket filed twice
# against other people's code. So it lives here.
#
# Four guards, each of which caught a real false result while this was written:
#
#   clean tree      reverting between mutants destroys uncommitted work, so it
#                   refuses rather than reverting over you
#   green baseline  a sweep over an already-red suite scores EVERY mutant killed.
#                   The sibling repo's CI reported "7 mutants, 0 survivors" and
#                   went green on a branch with four gates deliberately broken
#   anchor check    a mutation whose pattern no longer matches silently does
#                   nothing, and then "survives" for a reason unrelated to tests.
#                   Caught twice here after a refactor renamed writeSync to
#                   fs.writeSync
#   arity           delete every mutant and an unguarded sweep prints
#                   "0 mutants, 0 survivors" and exits 0
#
# Not yet wired into CI: genesis runs a single sequential job and adding a
# parallel gate is BRO-2407. Run it by hand before touching these files.
#
# Usage: scripts/mutation-sweep-walkie.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

SUITE=(apps/api/src/ask-log.test.ts apps/api/src/ask-log-fsync.test.ts
       apps/api/src/walkie-routes.test.ts apps/api/src/index-wiring.test.ts)
SUBJECTS=(apps/api/src/ask-log.ts apps/api/src/server.ts apps/api/src/index.ts)
EXPECTED_MUTANTS=15

if [ -n "$(git -c core.fsmonitor=false status --porcelain -- "${SUBJECTS[@]}" "${SUITE[@]}")" ]; then
  echo "REFUSING: the files under test are not clean — this script reverts them between mutants."
  git -c core.fsmonitor=false status --porcelain -- "${SUBJECTS[@]}" "${SUITE[@]}"
  exit 2
fi

echo "baseline — the suite must pass before anything is broken"
if ! baseline="$(bun test "${SUITE[@]}" 2>&1)"; then
  echo "  REFUSING: already failing, so no mutant verdict would mean anything."
  printf '%s\n' "$baseline" | grep '(fail)' | head -10 | sed 's/^/    /'
  exit 2
fi
echo "  baseline green"
echo

BAK="$(mktemp -d)"
for f in "${SUBJECTS[@]}"; do mkdir -p "$BAK/$(dirname "$f")"; cp "$f" "$BAK/$f"; done
restore() { for f in "${SUBJECTS[@]}"; do cp "$BAK/$f" "$f"; done; }
trap 'restore; rm -rf "$BAK"' EXIT

total=0
survivors=0

# mutate <label> <file> <anchor> <replacement> <expected-failing-test-substring>
mutate() {
  local label="$1" file="$2" anchor="$3" repl="$4" want="$5"
  total=$((total + 1))

  local covered=0 f
  for f in "${SUBJECTS[@]}"; do [ "$f" = "$file" ] && covered=1; done
  if [ "$covered" -ne 1 ]; then
    echo "  ERROR     $label — $file is not in SUBJECTS, so it would not be restored"
    survivors=$((survivors + 1)); return
  fi

  # Counted in python, not grep: grep is line-based (a multi-line anchor can
  # never match) and regex-based (a JSON or TS snippet with [ * ] blows up).
  local n
  n="$(python3 -c 'import sys;print(open(sys.argv[1]).read().count(sys.argv[2]))' "$file" "$anchor")"
  if [ "$n" -ne 1 ]; then
    echo "  ERROR     $label — anchor occurs $n times in $file, expected exactly 1"
    survivors=$((survivors + 1)); return
  fi

  python3 -c '
import sys, pathlib
p = pathlib.Path(sys.argv[1])
p.write_text(p.read_text().replace(sys.argv[2], sys.argv[3]))' "$file" "$anchor" "$repl"

  local out code
  out="$(bun test "${SUITE[@]}" 2>&1)"; code=$?
  restore

  if [ "$code" -eq 0 ]; then
    echo "  SURVIVED  $label"; survivors=$((survivors + 1))
  elif printf '%s' "$out" | grep '(fail)' | grep -q -- "$want"; then
    echo "  killed    $label"
  else
    # Matched against FAILING lines only: grepping the whole output lets a mutant
    # be scored killed on the strength of a test that passed.
    echo "  SURVIVED  $label — red, but not via \"$want\""
    printf '%s' "$out" | grep '(fail)' | head -3 | sed 's/^/              /'
    survivors=$((survivors + 1))
  fi
}

# shellcheck disable=SC2016
# The mutation anchors below are LITERAL TypeScript, so `${...}` and backticks must
# not expand — single quotes are the point, not an oversight.
A=apps/api/src/ask-log.ts
S=apps/api/src/server.ts
I=apps/api/src/index.ts

echo "durability — the write must leave the process, and reach the platter"
mutate "the append is buffered and never written" "$A" \
  'fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);' 'void record;' "survives a process restart"
mutate "fsync removed (page cache only)" "$A" \
  '    fs.fsyncSync(fd);
' '' "fsync"
mutate "opened truncating instead of appending" "$A" \
  'const fd = fs.openSync(file, "a");' 'const fd = fs.openSync(file, "w");' "append-only"

echo "idempotency — a repeated answer must not double-count"
mutate "answers keyed by insertion order instead of id" "$A" \
  'answers.set(v.id, v);' 'answers.set(`${v.id}:${answers.size}`, v);' "no-op"
mutate "duplicate asks no longer collapse" "$A" \
  '    if (seen.has(a.id)) continue;
' '' "stable id"

echo "separateness — an ask must never land in the intake queue"
mutate "asks written into queue.jsonl" "$A" \
  'const askPath = join(dir, ASK_FILE);' 'const askPath = join(dir, "queue.jsonl");' \
  "never lands in the voice intake queue"

echo "read tolerance — a torn line is skipped, an unreadable file is disclosed"
mutate "a torn line becomes fatal" "$A" \
  'try {
      out.push(JSON.parse(s));
    } catch {' \
  'if (true) {
      out.push(JSON.parse(s));
    } else if (false) {' "torn final line"
mutate "ENOENT reported as degradation" "$A" \
  'if (code === "ENOENT") return [];' \
  'if (code === "ENOENT") { onDegraded(name); return []; }' "healthy empty"

echo "the config gate"
mutate "routes registered unconditionally" "$S" \
  '  if (opts.walkieSecret) {' '  if (true) {' "do not exist"
mutate "build-throw for a missing sink removed" "$S" \
  '    if (!opts.askLog) {' '    if (false) {' "naming the sink"
mutate "build-throw for a missing dir removed" "$S" \
  '    if (!opts.askLogDir) {' '    if (false) {' "no directory throws"

echo "authorization"
mutate "auth check inverted to fail open" "$S" \
  '      !secretMatches(c.req.header("x-genesis-walkie-secret"), opts.walkieSecret ?? "");' \
  '      false;' "401"

echo "answer semantics"
mutate "unknown id silently accepted" "$S" \
  '      if (!known.some((a) => a.id === body.id)) {' '      if (false) {' "unknown id"
mutate "degraded flag swallowed" "$S" \
  '      return c.json(degraded ? { asks: entries, degraded } : { asks: entries });' \
  '      return c.json({ asks: entries });' "could not look"

echo "the entrypoint — routes wired only in tests do not exist in a deploy"
mutate "walkie unwired from build()" "$I" \
  '  walkieSecret,
  askLog,
  askLogDir,' '' "build() receives"

echo
if [ "$total" -ne "$EXPECTED_MUTANTS" ]; then
  echo "$total mutants ran, expected $EXPECTED_MUTANTS — a mutant was added or removed"
  exit 1
fi
restore
if [ -n "$(git -c core.fsmonitor=false status --porcelain -- "${SUBJECTS[@]}")" ]; then
  echo "the tree was not restored cleanly:"
  git -c core.fsmonitor=false status --porcelain -- "${SUBJECTS[@]}"
  exit 1
fi
if [ "$survivors" -eq 0 ]; then echo "$total mutants, 0 survivors"; else echo "$total mutants, $survivors SURVIVED"; fi
exit "$((survivors > 0))"
