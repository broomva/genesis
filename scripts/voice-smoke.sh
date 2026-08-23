#!/usr/bin/env bash
# Voice channel smoke (BRO-2228). Boots the real entrypoint, exercises every
# route, prints the queue, then tears down. No vendor account needed.
set -uo pipefail
WT=${WT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
PORT=${PORT:-8899}
SECRET=${SECRET:-smoke-secret}
D=$(mktemp -d /tmp/voice-smoke.XXXXXX)
cd "$WT/apps/api" || exit 1

# A fresh worktree has no node_modules, and the failure mode without this check is
# a bare "Cannot find module '@genesis/core'" from inside the boot, which reads as
# a broken build rather than a missing install.
if [ ! -d "$WT/node_modules/@genesis" ] && [ ! -d "$WT/apps/api/node_modules" ]; then
  echo "✗ dependencies are not installed in $WT"
  echo "  run: (cd $WT && bun install)"
  exit 2
fi

export GENESIS_DATA_DIR="$D/data" PORT="$PORT"
export GENESIS_VOICE_SECRET="$SECRET"
export GENESIS_VOICE_PRINCIPALS="+57 301 775-8620:Carlos,573214994114"

echo "▶ booting genesis with the voice channel ON  (data: $D)"
bun src/index.ts > "$D/server.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for i in $(seq 1 60); do curl -sf "http://localhost:$PORT/health" -o /dev/null && break; sleep 0.5; done
grep -i "voice channel" "$D/server.log" || { echo "✗ channel did not register"; cat "$D/server.log"; exit 1; }

H=(-H "x-genesis-voice-secret: $SECRET" -H 'content-type: application/json')
U="http://localhost:$PORT"
say () { printf '\n── %s\n' "$1"; }

say "known caller (dialed as +57 301 775 8620)"
curl -s -X POST "$U/voice/identify" "${H[@]}" -d '{"callerId":"+57 301 775 8620"}'; echo
say "unknown caller — a NORMAL outcome, not an error"
curl -s -X POST "$U/voice/identify" "${H[@]}" -d '{"callerId":"15550001111"}'; echo
say "wrong secret → 401"
curl -s -o /dev/null -w 'http %{http_code}\n' -X POST "$U/voice/identify" -H "x-genesis-voice-secret: wrong" -H 'content-type: application/json' -d '{"callerId":"573017758620"}'
say "leave a request"
curl -s -X POST "$U/voice/request" "${H[@]}" -d '{"callerId":"573017758620","request":"send me the August invoice","conversationId":"conv-1"}'; echo
say "the SAME call retried → identical ticketId"
curl -s -X POST "$U/voice/request" "${H[@]}" -d '{"callerId":"573017758620","request":"send me the August invoice","conversationId":"conv-1"}'; echo
say "empty request → caller-safe 400"
curl -s -X POST "$U/voice/request" "${H[@]}" -d '{"callerId":"573017758620","request":"  "}'; echo
say "non-string / oversized callerId → 400 on BOTH routes"
for p in identify request; do
  printf '  %-8s non-string  ' "$p"; curl -s -o /dev/null -w 'http %{http_code}\n' -X POST "$U/voice/$p" "${H[@]}" -d '{"callerId":42,"request":"x"}'
  printf '  %-8s oversized   ' "$p"; curl -s -o /dev/null -w 'http %{http_code}\n' -X POST "$U/voice/$p" "${H[@]}" -d "{\"callerId\":\"$(printf '9%.0s' {1..1000})\",\"request\":\"x\"}"
done
say "THE QUEUE — what a delivery leg will consume"
cat "$D/data/voice/queue.jsonl"
say "polarity: with NO secret configured the routes must not exist"
kill $PID 2>/dev/null; sleep 1
unset GENESIS_VOICE_SECRET
GENESIS_DATA_DIR="$D/off" PORT=$((PORT+1)) bun src/index.ts > "$D/off.log" 2>&1 &
PID=$!
for i in $(seq 1 60); do curl -sf "http://localhost:$((PORT+1))/health" -o /dev/null && break; sleep 0.5; done
for p in identify request; do
  printf '  /voice/%-9s ' "$p"; curl -s -o /dev/null -w 'http %{http_code}\n' -X POST "http://localhost:$((PORT+1))/voice/$p" -H 'content-type: application/json' -d '{"callerId":"573017758620","request":"x"}'
done
printf '\n✓ done. logs: %s\n' "$D"
