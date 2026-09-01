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

# server.test.ts IS IN THE SUITE, and its absence was a real hole: the voice-route
# bound tests live there, so the mutant that removes that bound was never exposed
# to the test written to kill it and SURVIVED for a reason unrelated to coverage.
# A sweep's suite has to include every file that tests its subjects — this one
# mutates server.ts, so every server.ts test belongs here.
SUITE=(apps/api/src/walkie-client.test.ts apps/api/src/ask-producer.test.ts packages/projection/src/asks-raised.test.ts
       apps/api/src/ask-log.test.ts apps/api/src/ask-log-fsync.test.ts
       apps/api/src/walkie-routes.test.ts apps/api/src/index-wiring.test.ts
       apps/api/src/server.test.ts
       apps/api/src/deployment-claims.test.ts
       apps/api/src/ttl-memo.test.ts
       # supervisor.ts is a SUBJECT, so its own tests belong here. Without this the
       # sweep scored supervisor mutants against a suite that excluded them: a
       # reversed sort in listThreads survived the sweep and was caught only by
       # supervisor.test.ts, which the sweep never ran.
       packages/core/src/supervisor.test.ts
       # Same rule, for the paging move (follow-up to BRO-2418): ordering and bounding now live
       # in the two Store implementations, so their tests have to run here or the
       # store mutants would be scored against a suite that cannot see them.
       packages/db/src/store.test.ts)
SUBJECTS=(apps/api/src/walkie-client.ts packages/projection/src/parser.ts apps/api/src/ask-log.ts apps/api/src/server.ts apps/api/src/index.ts apps/api/src/ttl-memo.ts
          packages/projection/src/reducer.ts packages/core/src/supervisor.ts
          packages/core/src/store.ts packages/db/src/store.ts)
EXPECTED_MUTANTS=98

# Subject paths used by mutants below. Defined HERE, not at first use: the
# paging mutants sit ~25 lines above where these used to be declared, and with
# `set -u` an undefined expansion aborts the run rather than mis-targeting.
CS=packages/core/src/store.ts
DS=packages/db/src/store.ts

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
  '        ...(degraded || sessionsUnread
          ? { degraded: [degraded, sessionsUnread].filter(Boolean).join("; ") }
          : {}),
      });' \
  '      });' \
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

# NOT a swap of the two guards. After the refactor `seen.add` sits AFTER the
# filter, so swapping them is harmless — a record the filter drops no longer
# consumes its id, and the mutant survived for that reason rather than for a
# missing test. The mutation that still reproduces the original cross-thread
# disclosure is claiming the id BEFORE the filter runs.
mutate "options cast instead of validated" "$A" \
  '      ...(options.length > 0 ? { options } : {}),' \
  '      ...(Array.isArray(raw.options) ? { options: raw.options as AskOption[] } : {}),' \
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
  '      const page = shown.slice(offset, offset + limit);' '      const page = shown;' \
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
# RE-AIMED, not deleted. It used to pin the "no producer yet" caveat; the producer
# exists now, so it pins the claim that replaced it. A mutant whose subject stops
# existing is a mutant that tests nothing, and deleting it would quietly drop the
# boot line out of the measured set.
mutate "the boot line stops naming the producer" "$I" \
  '${join(askLogDir, "asks.jsonl")} (producer live — an AskUserQuestion in any session appends here)`,' \
  '${join(askLogDir, "asks.jsonl")}`,' \
  "producer is live"

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
  '      typeof raw.sessionId !== "string" ||
      !raw.sessionId ||
      typeof raw.createdAt !== "string" ||
      !raw.createdAt' \
  '      typeof raw.sessionId !== "string" ||
      !raw.sessionId' \
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
mutate "the walkie route buffers the body unbounded again" "$S" \
  '      const read = await readBody(c.req.raw);
      if (!read.ok) return c.json(bodyReadError(read), read.reason === "too-large" ? 413 : 400);
      let raw: unknown;' \
  '      const read = { ok: true as const, text: await c.req.raw.text() };
      let raw: unknown;' \
  "one byte over the cap IS refused"
mutate "the stream is never cancelled past the cap" "$S" \
  '        await reader.cancel();
        return null;' \
  '        return null;' \
  "stream is CANCELLED past the cap"
mutate "no-store header dropped" "$S" \
  '      c.header("Cache-Control", "no-store");
      c.header("Pragma", "no-cache");' '      void c;' \
  "Cache-Control: no-store"
mutate "answering twice overwrites again" "$S" \
  '      if (existing.status === "answered") {' '      if (false) {' \
  "DIFFERENT second answer is a 409"
mutate "a row that states no thread is served under a fabricated thread again" "$A" \
  '    if (typeof a.threadId !== "string") {
      skipped++;
      continue;
    }' \
  '' \
  "thread-less row is still skipped"
mutate "a record with a thread but no question votes, and retracts a decision" "$A" \
  '    if (typeof a.question !== "string" || !a.question) {
      skipped++;
      continue;
    }' \
  '' \
  "naming a thread but NO question is skipped"
mutate "a transport fault is reported as a parse failure" "$S" \
  '    return { ok: false, reason: "transport" };' \
  '    return { ok: false, reason: "too-large" };' \
  "never fully arrives is 400"
mutate "readBody stops catching, so the fault escapes the handler" "$S" \
  '  let text: string | null;
  try {
    text = await readBounded(req, MAX_BODY_BYTES);
  } catch {
    return { ok: false, reason: "transport" };
  }' \
  '  const text: string | null = await readBounded(req, MAX_BODY_BYTES);' \
  "never fully arrives is 400"
# ANCHORED ON WHAT FOLLOWS, because the two voice routes carry byte-identical
# body-read blocks and the anchor must occur exactly once. /voice/identify
# destructures one field, /voice/request three — that is the only text that
# distinguishes them, so the mutation is expressed through it.
mutate "/voice/identify goes back to buffering unbounded" "$S" \
  '      const read = await readBody(c.req.raw);
      if (!read.ok) return c.json(bodyReadError(read), read.reason === "too-large" ? 413 : 400);
      try {
        raw = JSON.parse(read.text);
      } catch {
        return c.json({ error: "body must be JSON" }, 400);
      }
      const body = (raw ?? {}) as { callerId?: unknown };' \
  '      const read = { ok: true as const, text: await c.req.raw.text() };
      try {
        raw = JSON.parse(read.text);
      } catch {
        return c.json({ error: "body must be JSON" }, 400);
      }
      const body = (raw ?? {}) as { callerId?: unknown };' \
  "voice routes BOUND the body"
mutate "a differing second answer is accepted as recorded" "$S" \
  '        if (existing.answer === body.answer) {
          return c.json({ recorded: true, alreadyAnswered: true });
        }' \
  '        return c.json({ recorded: true, alreadyAnswered: true });
        if (false) {}' \
  "DIFFERENT second answer is a 409"

echo "the 409's threat model — a deliberate disclosure, so it is pinned"
mutate "an empty answer is accepted as a decision again" "$A" \
  '    typeof e.answer === "string" &&
    e.answer.length > 0 &&' \
  '    typeof e.answer === "string" &&' \
  "EMPTY answer is not a decision"
mutate "?thread= silently widens to every thread again" "$S" \
  '        ...(threadId !== undefined ? { threadId } : {}),' \
  '        ...(threadId ? { threadId } : {}),' \
  "narrows rather than silently widening"
mutate "/voice/request goes back to buffering unbounded" "$S" \
  '      const read = await readBody(c.req.raw);
      if (!read.ok) return c.json(bodyReadError(read), read.reason === "too-large" ? 413 : 400);
      try {
        raw = JSON.parse(read.text);
      } catch {
        return c.json({ error: "body must be JSON" }, 400);
      }
      const body = (raw ?? {}) as {
        callerId?: unknown;' \
  '      const read = { ok: true as const, text: await c.req.raw.text() };
      try {
        raw = JSON.parse(read.text);
      } catch {
        return c.json({ error: "body must be JSON" }, 400);
      }
      const body = (raw ?? {}) as {
        callerId?: unknown;' \
  "voice routes BOUND the body"

echo "atomicity — the property CodeRabbit called high-risk, measured instead"
# THE MUTATION IS AN `await`, not a deleted branch. The read-check-write span is
# atomic only because nothing suspends inside it; the way this breaks in real life
# is somebody making a call in that span asynchronous, not somebody deleting a
# guard. So the mutant is the realistic edit.
mutate "an await between the read and the write reopens the race" "$S" \
  '      const known = readAsks(askLogDir, { includeAnswered: true });' \
  '      const known = await Promise.resolve(readAsks(askLogDir, { includeAnswered: true }));' \
  "exactly one wins"

echo "paging — a cap without an offset makes the tail unreachable, not paged"
mutate "offset ignored, so the tail is unreachable again" "$S" \
  '      const page = shown.slice(offset, offset + limit);' \
  '      const page = shown.slice(0, limit);' \
  "with an offset it is reachable"
mutate "truncated goes back to 'the log is bigger than one page'" "$S" \
  '      const truncated = offset + page.length < shown.length;' \
  '      const truncated = shown.length > page.length;' \
  "more after THIS page"

echo "the composite key — what replaced the ambiguity machinery"
# The election, the withholding, the per-entry flag, the banner and the 409 are
# gone with the weak key they compensated for, and so are their seven mutants.
# Four remain, and each targets the key itself rather than a detector for its
# failure.
mutate "answers keyed by id alone, so a decision crosses threads again" "$A" \
  '  const key = (threadId: string, id: string) => JSON.stringify([threadId, id]);' \
  '  const key = (_threadId: string, id: string) => id;' \
  "does not surface on the other"
mutate "the dedupe drops back to the id, so one of two asks vanishes" "$A" \
  '    const k = key(a.threadId, a.id);
    if (seen.has(k)) continue;
    seen.add(k);' \
  '    const k = key(a.threadId, a.id);
    if (seen.has(a.id)) continue;
    seen.add(a.id);' \
  "BOTH are served"
mutate "POST stops requiring a threadId" "$S" \
  '      if (typeof body.threadId !== "string" || !body.threadId) {' \
  '      if (false) {' \
  "without a threadId is 400"
mutate "POST matches on the id alone, joining another thread's ask" "$S" \
  '      const existing = known.entries.find((a) => a.id === body.id && a.threadId === body.threadId);' \
  '      const existing = known.entries.find((a) => a.id === body.id);' \
  "WRONG thread is 404"

echo "the producer — the reason any of this writes anything (BRO-2413)"
P=packages/projection/src/reducer.ts
C=packages/core/src/supervisor.ts
mutate "the producer fires on the STATE, not the edge, and re-appends forever" "$C" \
  '            if (this.onAsk && !wasAwaiting && state.phase === "awaiting") {' \
  '            if (this.onAsk && state.phase === "awaiting") {' \
  "do not re-append"
mutate "a tool_use with no id yields an unanswerable ask" "$P" \
  '    if (typeof id !== "string" || !id) continue;' '' \
  "NO id raises nothing"
mutate "several questions in one call collapse onto one id" "$P" \
  '        toolUseId: qs.length > 1 ? `${id}#${i}` : id,' \
  '        toolUseId: id,' \
  "DISTINCT ids"
mutate "the single-question case grows a suffix the answer must reproduce" "$P" \
  '        toolUseId: qs.length > 1 ? `${id}#${i}` : id,' \
  '        toolUseId: `${id}#${i}`,' \
  "keeps the bare tool_use id"
mutate "only the camelCase tool name is recognised" "$P" \
  'const AWAIT_TOOLS = new Set(["AskUserQuestion", "ask_user_question"]);' \
  'const AWAIT_TOOLS = new Set(["AskUserQuestion"]);' \
  "snake_case tool name"
mutate "the parser drops the tool_use id again" "packages/projection/src/parser.ts" \
  '      id: typeof b.id === "string" ? b.id : undefined,' \
  '      id: undefined,' \
  "extracts the tool_use id"
# MUTATE THE HANDLER, NOT THE `try`. Removing `try {` leaves a dangling `catch`,
# so the file no longer parses and EVERY test goes red — the harness scores that
# as killed, but it is a crash and not a behaviour change. Re-throwing inside the
# catch reproduces the actual defect (a side-channel failure taking the turn down)
# while leaving the program valid.
mutate "a throwing producer takes the turn down with it" "$C" \
  '                  console.error(
                    `[genesis] ask producer failed (session=${session.id}): ${e instanceof Error ? e.message : String(e)}`,
                  );' \
  '                  throw e;' \
  "does not fail the turn"

echo "serving the client — a route that maps request text onto a filesystem"
W=apps/api/src/walkie-client.ts
mutate "containment checked without the separator, so a sibling dir gets in" "$W" \
  '  if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) return undefined;' \
  '  if (candidate !== base && !candidate.startsWith(base)) return undefined;' \
  "STARTS WITH THE ROOT"
mutate "resolution stops following symlinks" "$W" \
  '    candidate = realpathSync(resolve(join(base, rel)));' \
  '    candidate = resolve(join(base, rel));' \
  "symlink pointing out of the tree"
mutate "the content-type allowlist gains a permissive default" "$W" \
  '  if (!type) return undefined;' \
  '  if (!type) return { path: candidate, type: "application/octet-stream" };' \
  "outside the allowlist"
mutate "a directory is served as an asset" "$W" \
  '  if (statSync(candidate).isDirectory()) return undefined;' '' \
  "directory is not an asset"
mutate "a directory that is not a built client is accepted" "$S" \
  '      if (!existsSync(join(clientDir, "index.html")) || !existsSync(join(clientDir, "app.js"))) {' \
  '      if (false) {' \
  "not a built client is refused at BUILD"
mutate "only one of the two marker files is required" "$S" \
  '      if (!existsSync(join(clientDir, "index.html")) || !existsSync(join(clientDir, "app.js"))) {' \
  '      if (!existsSync(join(clientDir, "index.html"))) {' \
  "NO app.js is refused too"
mutate "the client route is registered even when unconfigured" "$S" \
  '    if (opts.walkieClientDir) {' '    if (true) {' \
  "unconfigured deploy has NO such route"

echo "stale asks — nothing ever ended an ask except an answer (BRO-2415)"
mutate "asks are never aged, so dead ones pile up forever" "$S" \
  '      const entries = markStale(raw, (t) => phases.get(t));' \
  '      const entries = raw;' \
  "session that finished retires its ask"
mutate "an UNKNOWN thread is treated as stale" "$A" \
  '    if (phase === undefined || phase === "awaiting") return e;' \
  '    if (phase === "awaiting") return e;' \
  "UNKNOWN thread is left alone"
mutate "an awaiting session is aged out with the rest" "$A" \
  '    if (phase === undefined || phase === "awaiting") return e;' \
  '    if (phase === undefined) return e;' \
  "still AWAITING keeps its ask"
mutate "an already-answered ask is re-marked stale" "$A" \
  '    if (e.status !== "pending") return e;' '' \
  "ANSWERED ask is never relabelled stale"
mutate "total counts the whole log again, not what is shown" "$S" \
  '        total: shown.length,' '        total: raw.length,' \
  "counts what is SHOWN"
mutate "a failed session read is silent, so the list looks clean" "$S" \
  '        sessionsUnread =
          "sessions could not be read; asks may be shown as pending after their turn ended";' \
  '' \
  "throws ages NOTHING"
mutate "the two degraded messages overwrite instead of joining" "$S" \
  '        ...(degraded || sessionsUnread
          ? { degraded: [degraded, sessionsUnread].filter(Boolean).join("; ") }
          : {}),' \
  '        ...(degraded ? { degraded } : {}),' \
  "both travel"
mutate "a throwing store retires every ask" "$S" \
  '        console.error("[walkie] could not read sessions; asks not aged:", e);' \
  '        throw e;' \
  "throws ages NOTHING"

echo "the deployment claims — a contradiction between two prose files is invisible to every other gate"
mutate "the retracted bind-to-localhost mitigation comes back unqualified" apps/api/src/index.ts \
  '"unauthenticated. Set GENESIS_TOKEN. Binding to localhost helps against a tailnet or LAN " +' \
  '"unauthenticated. Bind to localhost only, or set GENESIS_TOKEN." +' \
  "does not say bind-to-localhost is THE mitigation"
mutate "the source stops stating the /voice model" "$S" \
  'Funnel publishes exactly the' \
  'Funnel publishes something like the' \
  "says the funnel publishes the /voice prefix"

echo "read mirrors — the client's own gate, and only reads (BRO-2417)"
mutate "a mirror re-implements its body instead of sharing the twin's" "$S" \
  '      return c.json(await threadsBody(c));
    });

    app.get("/walkie/workspaces"' \
  '      return c.json({ threads: [] });
    });

    app.get("/walkie/workspaces"' \
  "exactly what its OWNER-GATED twin returns"
mutate "a mirror is gated by the owner token instead of the walkie secret" "$S" \
  '    app.get("/walkie/threads", async (c) => {
      noStore(c);
      if (walkieDenied(c)) return c.json({ error: "unauthorized" }, 401);' \
  '    app.get("/walkie/threads", async (c) => {
      noStore(c);
      if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);' \
  "the OWNER TOKEN opens no mirror"
mutate "noStore dropped from the checks MIRROR (P20 round-2 survivor)" "$S" \
  '    app.get("/walkie/workspaces/:id/checks", async (c) => {
      noStore(c);' \
  '    app.get("/walkie/workspaces/:id/checks", async (c) => {' \
  "EVERY mirror is no-store"
mutate "walkieDenied stripped from the git/diff MIRROR (the A+B+C blocker)" "$S" \
  '    app.get("/walkie/workspaces/:id/git/diff", async (c) => {
      noStore(c);
      if (walkieDenied(c)) return c.json({ error: "unauthorized" }, 401);' \
  '    app.get("/walkie/workspaces/:id/git/diff", async (c) => {
      noStore(c);' \
  "EVERY mirror is 401 with no credential"
mutate "walkieDenied stripped from the checks MIRROR" "$S" \
  '    app.get("/walkie/workspaces/:id/checks", async (c) => {
      noStore(c);
      if (walkieDenied(c)) return c.json({ error: "unauthorized" }, 401);' \
  '    app.get("/walkie/workspaces/:id/checks", async (c) => {
      noStore(c);' \
  "EVERY mirror is 401 with no credential"
mutate "a git mirror is deleted outright" "$S" \
  '    app.get("/walkie/workspaces/:id/git/status", async (c) => {
      noStore(c);
      if (walkieDenied(c)) return c.json({ error: "unauthorized" }, 401);
      return gitStatusBody(c, c.req.param("id"));
    });' \
  '' \
  "the walkie secret opens EVERY mirror"
mutate "a WRITE verb is added to the walkie namespace" "$S" \
  '    // The decision coming back.
    app.post("/walkie/answer", async (c) => {' \
  '    app.post("/walkie/workspaces/:id/git/commit", async (c) => {
      if (walkieDenied(c)) return c.json({ error: "unauthorized" }, 401);
      return c.json({ committed: true });
    });

    // The decision coming back.
    app.post("/walkie/answer", async (c) => {' \
  "the only non-GET verb under /walkie is the answer"
mutate "the walkie-without-token build invariant removed" "$S" \
  '    if (!opts.token) {
      throw new Error(
        "walkieSecret is set but token is not:' \
  '    if (opts.token === "\x00never") {
      throw new Error(
        "walkieSecret is set but token is not:' \
  "walkieSecret without a token throws at BUILD"
mutate "the shared git body stops checking the workspace exists" "$S" \
  '    const root = await supervisor.resolveWorkspaceRoot(id);
    if (!root) return c.json({ error: "unknown workspace" }, 404);
    try {
      return c.json(await gitStatus(root));' \
  '    const root = (await supervisor.resolveWorkspaceRoot(id)) ?? "/";
    try {
      return c.json(await gitStatus(root));' \
  "an unknown workspace is 404 WITH THE BODY"

echo "the entrypoint — routes wired only in tests do not exist in a deploy"
mutate "walkie unwired from build()" "$I" \
  '  walkieSecret,
  askLog,
  askLogDir,' '' "build() receives"

echo
# --- BRO-2418: the polled surface is bounded ------------------------------
#
# Four guards, each with a mutant, because a bound nobody can see fail is a
# comment. The first is the one that matters: paging the RESULT instead of the
# source produces an identical response while still reading every turn of every
# session, so only a test that counts the reads can tell them apart.

M=apps/api/src/ttl-memo.ts

mutate "listThreads pages the RESULT, so the work stays O(box)" "$CS" \
  "    const page =
      opts.limit === undefined ? ordered.slice(offset) : ordered.slice(offset, offset + opts.limit);" \
  "    const page = ordered.slice(offset);" \
  "bounds the WORK"

mutate "the 200 cap on /threads stops truncating" "$S" \
  "Math.min(rawLimit, 200) : 200;" \
  "rawLimit : 200;" \
  "cap TRUNCATES"

mutate "hasMore inferred from a full page (true on the last one)" "$S" \
  "    return { threads, total, hasMore: offset + threads.length < total };" \
  "    return { threads, total, hasMore: threads.length === limit };" \
  "final page that happens to be exactly full"

mutate "the checks cache stores AFTER resolving, losing in-flight de-duplication" "$M" \
  "    entries.set(key, entry);" \
  "    value.then(() => entries.set(key, entry));" \
  "CONCURRENT calls share ONE execution"

# Paging moved into the Store (follow-up to BRO-2418): the comparator that used to live in
# supervisor.ts is now `compareSessionsNewestFirst`, and the bound is SQL. The
# anchor moved with it — a sweep whose anchor no longer exists ERRORs rather
# than silently scoring nothing, which is how this one was caught.
mutate "listThreads stops ordering newest-first" "$CS" \
  '  a.createdAt < b.createdAt
    ? 1
    : a.createdAt > b.createdAt
      ? -1' \
  '  a.createdAt < b.createdAt
    ? -1
    : a.createdAt > b.createdAt
      ? 1' \
  "ordered newest-first"
mutate "ties lose their id tiebreaker, so page boundaries stop being stable" "$CS" \
  '      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;' \
  '      : 0;' \
  "identical pages at every boundary"
mutate "the pg page stops bounding at the source and slices nothing" "$DS" \
  '        : ordered.limit(opts.limit).offset(opts.offset ?? 0);' \
  '        : ordered.offset(opts.offset ?? 0);' \
  "no query retrieves more rows than the window"
mutate "the page total becomes a stub instead of a count" "$DS" \
  '.select({ ...getTableColumns(sessions), total: sql<number>`count(*) over()` })' \
  '.select({ ...getTableColumns(sessions), total: sql<number>`0` })' \
  "the total describes the page"
mutate "the empty-page total fallback is removed, so a past-the-end page reports NaN" "$DS" \
  '    if (rows.length === 0) {' \
  '    if (false) {' \
  "identical pages at every boundary"
mutate "the pg ORDER BY drops COLLATE C and follows the database locale" "$DS" \
  '.orderBy(sql`${sessions.createdAt} COLLATE "C" DESC, ${sessions.id} COLLATE "C" ASC`);' \
  '.orderBy(sql`${sessions.createdAt} DESC, ${sessions.id} ASC`);' \
  "pins COLLATE"

mutate "the memo evicts an entry a later call already replaced" "$M" \
  "      if (entries.get(key)?.value === value) entries.delete(key);" \
  "      entries.delete(key);" \
  "late rejection does not evict"

mutate "the default page size drops to 50" "$S" \
  "Math.min(rawLimit, 200) : 200;" \
  "Math.min(rawLimit, 200) : 50;" \
  "DEFAULT is 200"

mutate "the route scans sessions twice per request" "$S" \
  "    const { threads, total } = await supervisor.listThreadsPage({ limit, offset });" \
  "    const threads = await supervisor.listThreads({ limit, offset }); const total = (await supervisor.listThreadsPage({})).total;" \
  "NO full scan"

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
