#!/usr/bin/env bash
# Voice channel smoke (BRO-2228/2257). Boots the real entrypoint, ASSERTS every
# route's response, prints the queue, then tears down.
#
# WHY EVERY CHECK IS AN ASSERTION AND THE SCRIPT TRACKS FAILURES. The first
# version of this printed each response and ended with a checkmark, which meant a
# 500 where a 400 belonged, or a queue file that never appeared, still exited 0 —
# a harness that cannot report red is not a harness. There is a deliberate
# self-test below: NEGATIVE_CONTROL=1 injects a wrong expectation and the run MUST
# fail, which is the only evidence that a green run means anything.
#
# `set -e` is deliberately NOT used: a failed assertion must be COUNTED and the
# server still torn down, not abort the script mid-run leaving a stray process.
set -uo pipefail

WT=${WT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
PORT=${PORT:-8899}
SECRET=${SECRET:-smoke-secret}
D=$(mktemp -d /tmp/voice-smoke.XXXXXX)
FAILED=0
PID=""
cleanup () { [ -n "$PID" ] && kill "$PID" 2>/dev/null; }
trap cleanup EXIT INT TERM

cd "$WT/apps/api" || exit 1
if [ ! -d "$WT/node_modules/@genesis" ] && [ ! -d "$WT/apps/api/node_modules" ]; then
  echo "✗ dependencies are not installed in $WT"
  echo "  run: (cd $WT && bun install)"
  exit 2
fi

ok ()   { printf '  ✓ %s\n' "$1"; }
bad ()  { printf '  ✗ %s\n     expected: %s\n     actual:   %s\n' "$1" "$2" "$3"; FAILED=$((FAILED+1)); }
# eq <label> <expected> <actual>
eq ()   { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
# has <label> <needle> <haystack>
has ()  { case "$3" in *"$2"*) ok "$1";; *) bad "$1" "contains $2" "$3";; esac }
status () { curl -s -o /dev/null -w '%{http_code}' "$@"; }
body ()   { curl -s "$@"; }

H=(-H "x-genesis-voice-secret: $SECRET" -H 'content-type: application/json')
U="http://localhost:$PORT"

echo "▶ booting genesis with the voice channel ON  (data: $D)"
GENESIS_DATA_DIR="$D/data" PORT="$PORT" GENESIS_VOICE_SECRET="$SECRET" \
  GENESIS_VOICE_PRINCIPALS="+57 301 775-8620:Carlos,573214994114" \
  bun src/index.ts > "$D/server.log" 2>&1 &
PID=$!
for _ in $(seq 1 60); do curl -sf "$U/health" -o /dev/null && break; sleep 0.5; done
if ! grep -qi "voice channel" "$D/server.log"; then
  echo "✗ the voice channel did not register at boot"; sed -n '1,20p' "$D/server.log"; exit 1
fi
ok "channel registered at boot"

echo "▶ identify"
R=$(body -X POST "$U/voice/identify" "${H[@]}" -d '{"callerId":"+57 301 775 8620"}')
eq  "a human-spelled principal matches a dialed caller" '{"known":true,"canFollowUp":false}' "$R"
R=$(body -X POST "$U/voice/identify" "${H[@]}" -d '{"callerId":"15550001111"}')
eq  "an unknown caller is a normal 200" '{"known":false,"canFollowUp":false}' "$R"
eq  "a wrong secret is 401" "401" "$(status -X POST "$U/voice/identify" -H "x-genesis-voice-secret: wrong" -H 'content-type: application/json' -d '{"callerId":"573017758620"}')"

echo "▶ request"
R=$(body -X POST "$U/voice/request" "${H[@]}" -d '{"callerId":"573017758620","request":"send me the August invoice","conversationId":"conv-1"}')
has "a request is accepted" '"ticketId"' "$R"
has "and promises NO follow-up (nothing drains the queue)" '"followUp":"none"' "$R"
T1=$(printf '%s' "$R" | sed 's/.*"ticketId":"\([^"]*\)".*/\1/')
R2=$(body -X POST "$U/voice/request" "${H[@]}" -d '{"callerId":"573017758620","request":"send me the August invoice","conversationId":"conv-1"}')
T2=$(printf '%s' "$R2" | sed 's/.*"ticketId":"\([^"]*\)".*/\1/')
eq  "a retried tool call reuses the ticket id" "$T1" "$T2"
eq  "an empty request is a caller-safe 400" "400" "$(status -X POST "$U/voice/request" "${H[@]}" -d '{"callerId":"573017758620","request":"  "}')"

echo "▶ both routes agree on what a callerId may be"
for p in identify request; do
  eq "  /voice/$p rejects a non-string" "400" "$(status -X POST "$U/voice/$p" "${H[@]}" -d '{"callerId":42,"request":"x"}')"
  eq "  /voice/$p rejects an oversized id" "400" "$(status -X POST "$U/voice/$p" "${H[@]}" -d "{\"callerId\":\"$(printf '9%.0s' {1..1000})\",\"request\":\"x\"}")"
done

echo "▶ the queue"
Q="$D/data/voice/queue.jsonl"
if [ -f "$Q" ]; then
  eq "two records were persisted" "2" "$(wc -l < "$Q" | tr -d ' ')"
  has "the ticket carries its delivery target" '"deliverTo":"573017758620"' "$(head -1 "$Q")"
  cat "$Q"
else
  bad "the queue file exists" "$Q" "missing"
fi

echo "▶ polarity: with NO secret configured the routes must not exist"
kill "$PID" 2>/dev/null; PID=""
sleep 1
GENESIS_DATA_DIR="$D/off" PORT=$((PORT+1)) bun src/index.ts > "$D/off.log" 2>&1 &
PID=$!
for _ in $(seq 1 60); do curl -sf "http://localhost:$((PORT+1))/health" -o /dev/null && break; sleep 0.5; done
for p in identify request; do
  eq "  /voice/$p is 404 when unconfigured" "404" "$(status -X POST "http://localhost:$((PORT+1))/voice/$p" -H 'content-type: application/json' -d '{"callerId":"573017758620","request":"x"}')"
done
[ -d "$D/off/voice" ] && bad "no queue dir is created when unconfigured" "absent" "present" || ok "no queue dir is created when unconfigured"

# Self-test: prove this harness is capable of reporting red at all.
if [ "${NEGATIVE_CONTROL:-0}" = "1" ]; then
  eq "NEGATIVE CONTROL (must fail)" "this-never-matches" "reality"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ all checks passed. logs: $D"
else
  echo "✗ $FAILED check(s) FAILED. logs: $D"
fi
exit $((FAILED > 0 ? 1 : 0))
