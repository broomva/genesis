#!/usr/bin/env bash
# shellcheck disable=SC2016
#   Every mutation anchor below is LITERAL TypeScript, so `${...}` and backticks
#   must NOT expand — the single quotes are the mechanism, not an oversight. A
#   file-level directive because it applies to fifteen call sites; scoped to one
#   assignment (where it was first put) it silently applied to nothing.
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
EXPECTED_MUTANTS=42

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
#
# The last argument is matched against the (fail) LINES, which carry TEST NAMES —
# not assertion messages, not error strings. Writing an error message there is a
# mistake I made three times: the mutant IS killed, the script reports SURVIVED
# "red, but not via <want>", and the verdict looks like a missing test when it is
# a mistyped expectation. If you see that, check the want string before the code.
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

A=apps/api/src/ask-log.ts
S=apps/api/src/server.ts
I=apps/api/src/index.ts

echo "durability — the write must leave the process, and reach the platter"
mutate "the append is buffered and never written" "$A" \
  '    let written = 0;' \
  '    let written = line.length;' \
  "survives a process restart"
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
  '      if (!existing) {' '      if (false) {' "unknown id"
mutate "degraded flag swallowed on GET" "$S" \
  '        asks: page,
        total: entries.length,
        ...(truncated ? { truncated: true } : {}),
        ...(degraded ? { degraded } : {}),' \
  '        asks: page,
        total: entries.length,
        ...(truncated ? { truncated: true } : {}),' \
  "could not look"

echo "P20 findings — each of these shipped once"
# NOTE: mutate `written += n` and NOT the `n <= 0` guard. Removing that guard makes
# a zero-byte write spin forever, so the mutant hangs the sweep instead of failing
# it — a mutant that never terminates is as useless as one that survives. This
# replacement reproduces the ORIGINAL defect exactly (assume the write completed)
# and terminates.
mutate "short write silently ignored — the count is assumed, not read" "$A" \
  '      written += n;' \
  '      written = line.length;' \
  "every byte of the record reaches the file"

mutate "dedupe moved back before the thread filter" "$A" \
  '    if (opts?.threadId !== undefined && threadId !== opts.threadId) continue;

    if (seen.has(a.id)) continue;
    seen.add(a.id);' \
  '    if (seen.has(a.id)) continue;
    seen.add(a.id);
    if (opts?.threadId !== undefined && threadId !== opts.threadId) continue;' \
  "do not mask each other"
mutate "options cast instead of validated" "$A" \
  '      ...(options.length > 0 ? { options } : {}),' \
  '      ...(Array.isArray(a.options) ? { options: a.options as AskOption[] } : {}),' \
  "malformed options"
mutate "degraded overwrites instead of accumulating" "$A" \
  '    if (!problems.includes(m)) problems.push(m);' \
  '    problems.length = 0; problems.push(m);' \
  "reports BOTH"
mutate "production fsync replaced by a no-op" "$A" \
  'export const REAL_FS: DurableFs = { openSync, writeSync, fsyncSync, closeSync };' \
  'export const REAL_FS: DurableFs = { openSync, writeSync, fsyncSync: () => {}, closeSync };' \
  "real syscalls"
mutate "result bound removed" "$S" \
  '      const page = entries.slice(0, limit);' '      const page = entries;' \
  "bounded"
mutate "answer length cap removed" "$S" \
  '      if (body.answer.length > MAX_ANSWER_CHARS) {' '      if (false) {' \
  "oversized answer"
mutate "degraded dropped on POST, unreadable log becomes 404" "$S" \
  '      if (known.unreadable) {' '      if (false) {' \
  "never .no such ask"
# The three below are the split between "a FILE could not be read" and "a RECORD
# was malformed". Conflating them is not hypothetical: it is what the first
# version of the malformed-record change did, and a live server was the only
# thing that noticed.
mutate "POST gates on degraded again — one bad line blocks every answer" "$S" \
  '      if (known.unreadable) {' '      if (known.degraded) {' \
  "POST succeeds while the log reports malformed records"
mutate "the unreadable flag is never set" "$A" \
  '  const noteUnreadable = (m: string) => {
    unreadable = true;
    note(m);
  };' \
  '  const noteUnreadable = (m: string) => {
    note(m);
  };' \
  "POST still refuses when a FILE cannot be read"
mutate "the answers file no longer reports its own unreadability" "$A" \
  'for (const v of readLines(dir, ANSWER_FILE, noteUnreadable))' \
  'for (const v of readLines(dir, ANSWER_FILE, note))' \
  "unreadable answers.jsonl also refuses"

mutate "answeredAt type check removed" "$A" \
  '    (e.answeredAt === undefined || typeof e.answeredAt === "string")' \
  '    true' \
  "answeredAt"
mutate "pre-parse body guard removed" "$S" \
  '      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {' \
  '      if (false) {' \
  "Content-Length is 413"
# ANCHOR REPAIRED, and how it broke is the point. `biome check --write --unsafe`
# collapsed this boot line's string concat into one template literal, so the
# anchor stopped matching — and the commit that did it still claimed "26 mutants,
# 0 survivors", because that number was measured BEFORE the formatter ran. The
# anchor guard is the only reason this is a caught error rather than a silent
# false pass. A formatter is a code change.
mutate "the producer-gap caveat removed from the boot line" "$I" \
  '${join(askLogDir, "asks.jsonl")} (routes live; no producer yet — asks are not written by anything)`,' \
  '${join(askLogDir, "asks.jsonl")}`,' \
  "no producer"

echo "malformed-record accounting — silence must not mean 'nothing pending'"
mutate "the skipped-record message is never emitted" "$A" \
  '  if (skipped > 0) note(`${skipped} ask record(s) skipped: no usable id or question`);' \
  '' \
  "a record with no id is counted"
mutate "the incomplete-record message is never emitted" "$A" \
  '  if (incomplete > 0) note(`${incomplete} ask record(s) missing sessionId or createdAt`);' \
  '' \
  "askedAt instead of createdAt"
mutate "the count degrades to a boolean" "$A" \
  '  if (skipped > 0) note(`${skipped} ask record(s) skipped: no usable id or question`);' \
  '  if (skipped > 0) note("1 ask record(s) skipped: no usable id or question");' \
  "the count is the number of bad records"
mutate "the incomplete check loses its createdAt half" "$A" \
  '    if (
      typeof a.sessionId !== "string" ||
      !a.sessionId ||
      typeof a.createdAt !== "string" ||
      !a.createdAt
    ) {' \
  '    if (typeof a.sessionId !== "string" || !a.sessionId) {' \
  "createdAt missing"
mutate "a non-object line goes back to a bare continue" "$A" \
  '    if (!v || typeof v !== "object") {
      skipped++;
      continue;
    }' \
  '    if (!v || typeof v !== "object") {
      continue;
    }' \
  "not an object"

echo "the four merge-risk findings — each MEASURED against a live server first"
mutate "the body cap never trips" "$S" \
  '      if (total > max) {' '      if (false) {' \
  "one byte over the cap returns null"
mutate "the route buffers the body unbounded again" "$S" \
  '      const text = await readBounded(c.req.raw, MAX_BODY_BYTES);' \
  '      const text = await c.req.raw.text();' \
  "CHUNKED oversized body is refused"
mutate "the stream is never cancelled past the cap" "$S" \
  '        await reader.cancel();
        return null;' \
  '        return null;' \
  "stream is CANCELLED past the cap"
mutate "no-store header dropped" "$S" \
  '      c.header("Cache-Control", "no-store");' '      void c;' \
  "Cache-Control: no-store"
mutate "answering twice overwrites again" "$S" \
  '      if (existing.status === "answered") {' '      if (false) {' \
  "does NOT change the recorded decision"
mutate "ambiguous ids get an answer attached anyway" "$A" \
  '    const ans = ambiguous.has(a.id) ? undefined : answers.get(a.id);' \
  '    const ans = answers.get(a.id);' \
  "never crosses a thread boundary"
mutate "a collision is no longer detected" "$A" \
  '  for (const [id, threads] of threadsById) if (threads.size > 1) ambiguous.add(id);' \
  '  for (const [id, threads] of threadsById) if (threads.size > 99) ambiguous.add(id);' \
  "never crosses a thread boundary"
mutate "POST accepts an ambiguous id" "$S" \
  '      if (known.ambiguous?.has(body.id)) {' '      if (false) {' \
  "ambiguous id is refused with 409"

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
