#!/usr/bin/env bash
# Dogfood the walkie surface against a REAL running genesis server (BRO-2387).
#
# WHY THIS IS COMMITTED, same argument as scripts/mutation-sweep-walkie.sh: a
# result nobody else can regenerate is not evidence. It is here because it EARNED
# its place — it found two defects that 1691 unit tests and a 34-mutant sweep both
# reported green on:
#
#   1. an ask written with a field name the type does not have came back as a
#      well-formed ask with createdAt:"" and no `degraded` — every fixture in the
#      suite is built by `append`, which is typed, so the suite was structurally
#      incapable of producing the shape
#   2. the FIX for (1) then made POST refuse on any malformed record, so one bad
#      line in an append-only journal blocked answering every other ask forever
#
# Three rules it enforces, each learned by getting it wrong first:
#   - bind-test the port; a stranger's server on it produces a confident false negative
#   - assert a known-good PRE-EXISTING endpoint before testing the new one, so a
#     pass proves you reached genesis and not something else listening
#   - branch on failure; printing an exit code and continuing is not a gate
#
# Usage: scripts/dogfood-walkie.sh   (needs bun; leaves artifacts in a temp dir)
set -uo pipefail

WT="$(cd "$(dirname "$0")/.." && pwd)"
RUN=$(mktemp -d)
LOG="$RUN/server.log"
ASKDIR="$RUN/walkie"
SECRET="dogfood-secret-$$"
FAIL=0

say() { printf '\n== %s ==\n' "$1"; }
ok()  { printf '  PASS  %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; FAIL=1; }
chk() { # chk <label> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1 → $3"; else bad "$1 → expected [$2] got [$3]"; fi
}

# --- 1. pick a port and PROVE it is free (bind it, then release) -------------
PORT=$(python3 - <<'PY'
import socket
s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()
PY
)
if curl -s -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  bad "port $PORT already answers — refusing to dogfood a stranger's server"; exit 1
fi
say "port $PORT is free (bind-tested, nothing answers)"

# --- 2. boot the REAL entrypoint --------------------------------------------
cd "$WT" || { bad "worktree missing"; exit 1; }
echo "  tip: $(git rev-parse --short HEAD)  clean: $(git -c core.fsmonitor=false status --porcelain | wc -l | tr -d ' ') dirty files"
PORT=$PORT \
GENESIS_WALKIE_SECRET="$SECRET" \
GENESIS_ASK_LOG_DIR="$ASKDIR" \
GENESIS_DATA_DIR="$RUN/data" \
GENESIS_WORKSPACE_ROOT="$RUN/ws" \
  bun apps/api/src/index.ts >"$LOG" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; wait $SRV 2>/dev/null' EXIT

for _ in $(seq 1 60); do
  curl -s -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  kill -0 $SRV 2>/dev/null || { bad "server died during boot"; sed -n '1,60p' "$LOG"; exit 1; }
  sleep 0.5
done

# --- 3. POSITIVE CONTROL: is this actually genesis? --------------------------
say "positive control"
H=$(curl -s -m 3 "http://127.0.0.1:$PORT/health")
case "$H" in
  *ok*) ok "/health answers genesis-shaped JSON: $H" ;;
  *)    bad "/health did not look like genesis: [$H]"; exit 1 ;;
esac
if grep -q 'walkie: ask log at' "$LOG"; then
  ok "boot line: $(grep -m1 'walkie:' "$LOG")"
else
  bad "no walkie boot line — the config gate did not fire"
fi

B="http://127.0.0.1:$PORT"
S="x-genesis-walkie-secret: $SECRET"
code() { curl -s -o "$RUN/body" -w '%{http_code}' "$@"; }

# --- 4. the surface ----------------------------------------------------------
say "auth"
chk "GET /walkie/asks with NO secret"    401 "$(code "$B/walkie/asks")"
chk "GET /walkie/asks with WRONG secret" 401 "$(code -H 'x-genesis-walkie-secret: nope' "$B/walkie/asks")"
chk "secret in QUERY STRING is rejected" 401 "$(code "$B/walkie/asks?secret=$SECRET")"
chk "GET /walkie/asks with the secret"   200 "$(code -H "$S" "$B/walkie/asks")"
echo "  body: $(cat "$RUN/body")"

say "the producer gap (this is the point)"
if [ "$(cat "$RUN/body")" = '{"asks":[],"total":0}' ]; then
  ok "empty — nothing in the repo writes an ask, exactly as the PR declares"
else
  bad "expected an empty log on a fresh dir, got: $(cat "$RUN/body")"
fi

say "answer validation"
chk "POST no secret"          401 "$(code -X POST -H 'content-type: application/json' -d '{}' "$B/walkie/answer")"
chk "POST non-JSON body"      400 "$(code -X POST -H "$S" -H 'content-type: application/json' -d 'not json' "$B/walkie/answer")"
chk "POST missing id"         400 "$(code -X POST -H "$S" -H 'content-type: application/json' -d '{"answer":"yes"}' "$B/walkie/answer")"
chk "POST empty answer"       400 "$(code -X POST -H "$S" -H 'content-type: application/json' -d '{"id":"a1","answer":""}' "$B/walkie/answer")"
chk "POST unknown id → 404"   404 "$(code -X POST -H "$S" -H 'content-type: application/json' -d '{"id":"nope","answer":"yes"}' "$B/walkie/answer")"
LONG=$(python3 -c 'print("x"*5000)')
chk "POST 5000-char answer"   413 "$(code -X POST -H "$S" -H 'content-type: application/json' -d "{\"id\":\"a1\",\"answer\":\"$LONG\"}" "$B/walkie/answer")"
HUGE=$(python3 -c 'print("y"*70000)')
chk "POST 70KB body"          413 "$(code -X POST -H "$S" -H 'content-type: application/json' -d "{\"id\":\"a1\",\"answer\":\"$HUGE\"}" "$B/walkie/answer")"

# --- 5. hand-write an ask, because nothing else can --------------------------
say "round trip (ask hand-written — there is no producer)"
mkdir -p "$ASKDIR"
cat >> "$ASKDIR/asks.jsonl" <<'JSON'
{"id":"ask-1","threadId":"t-alpha","question":"Ship BRO-2387 or hold for the producer?","askedAt":"2026-08-31T12:00:00.000Z","options":["ship","hold"]}
{"id":"ask-2","threadId":"t-beta","question":"SECRET-OF-THREAD-BETA","askedAt":"2026-08-31T12:01:00.000Z"}
JSON
chk "GET after append" 200 "$(code -H "$S" "$B/walkie/asks")"
echo "  body: $(cat "$RUN/body")"
if grep -q 'ask-1' "$RUN/body"; then ok "the hand-written ask is served"; else bad "ask-1 not served"; fi
# The finding from the FIRST dogfood run: these records use `askedAt`, not
# `createdAt`, and came back looking well-formed. They must now say so.
if grep -q 'missing sessionId or createdAt' "$RUN/body"; then
  ok "the incomplete records are disclosed, not served as if fine"
else
  bad "a record with createdAt:\"\" was served with no degraded field"
fi

say "cross-thread disclosure (the P20 blocker)"
code -H "$S" "$B/walkie/asks?thread=t-alpha" >/dev/null
if grep -q 'SECRET-OF-THREAD-BETA' "$RUN/body"; then
  bad "?thread=t-alpha leaked another thread's question text"
else
  ok "?thread=t-alpha does not leak t-beta"
fi

say "answering"
chk "POST valid answer" 200 "$(code -X POST -H "$S" -H 'content-type: application/json' -d '{"id":"ask-1","answer":"ship it"}' "$B/walkie/answer")"
code -H "$S" "$B/walkie/asks" >/dev/null
if grep -q 'ask-1' "$RUN/body"; then bad "answered ask still listed as pending"; else ok "answered ask drops out of the pending list"; fi
chk "re-posting the SAME answer is a 200 no-op" 200 "$(code -X POST -H "$S" -H 'content-type: application/json' -d '{"id":"ask-1","answer":"ship it"}' "$B/walkie/answer")"
# THE DISCRIMINATOR. The check above posts identical text and compares only the
# status code, which is 200 under first-answer-wins AND under the last-write-wins
# it replaced — so with the guard deleted this script stayed fully green and the
# P11 receipt rested on a unit test. Posting a DIFFERENT answer is what separates
# the two builds.
chk "a DIFFERENT second answer is refused" 409 "$(code -X POST -H "$S" -H 'content-type: application/json' -d '{"id":"ask-1","answer":"HOLD-INSTEAD"}' "$B/walkie/answer")"
code -H "$S" "$B/walkie/asks?answered=1" >/dev/null
if grep -q 'HOLD-INSTEAD' "$RUN/body"; then
  bad "the second answer replaced the first — last write won"
else
  ok "the first decision still stands"
fi
echo "  answers.jsonl: $(cat "$ASKDIR/answers.jsonl" 2>/dev/null)"

# --- 6. restart survival ------------------------------------------------------
say "restart survival (kill -9, not a graceful close)"
kill -9 $SRV 2>/dev/null; wait $SRV 2>/dev/null
PORT=$PORT GENESIS_WALKIE_SECRET="$SECRET" GENESIS_ASK_LOG_DIR="$ASKDIR" \
GENESIS_DATA_DIR="$RUN/data" GENESIS_WORKSPACE_ROOT="$RUN/ws" \
  bun apps/api/src/index.ts >>"$LOG" 2>&1 &
SRV=$!
for _ in $(seq 1 60); do curl -s -m 1 "$B/health" >/dev/null 2>&1 && break; sleep 0.5; done
code -H "$S" "$B/walkie/asks?answered=1" >/dev/null
if grep -q 'ship it' "$RUN/body"; then ok "the answer survived kill -9 + restart"; else bad "answer LOST across restart: $(cat "$RUN/body")"; fi

# --- 7. degraded read ---------------------------------------------------------
say "degraded read (unreadable log must not read as 'nothing pending')"
chmod 000 "$ASKDIR/asks.jsonl"
GOT=$(code -H "$S" "$B/walkie/asks")
BODY=$(cat "$RUN/body")
if [ "$GOT" = 200 ] && echo "$BODY" | grep -q 'degraded'; then
  ok "GET reports degraded rather than an empty list: $BODY"
elif [ "$GOT" = 200 ] && [ "$BODY" = '{"asks":[],"total":0}' ]; then
  bad "unreadable log served as 'nothing pending' — the exact failure the code claims to prevent"
else
  # NOT `ok`. A trailing else that passes is a branch that cannot fail, and the
  # only outcomes it can catch now are ones nobody predicted — a 200 carrying
  # asks from a log that cannot be read, say. Unexpected is not the same as fine.
  bad "GET on unreadable log → unexpected $GOT $BODY"
fi
chk "POST refuses while degraded" 503 "$(code -X POST -H "$S" -H 'content-type: application/json' -d '{"id":"ask-2","answer":"x"}' "$B/walkie/answer")"
chmod 644 "$ASKDIR/asks.jsonl"

say "server log (stderr from the run)"
grep -i 'error\|walkie\|degraded' "$LOG" | head -20

say "RESULT"
[ $FAIL -eq 0 ] && echo "  ALL CHECKS PASSED" || echo "  THERE WERE FAILURES"
echo "  artifacts: $RUN"
exit $FAIL
