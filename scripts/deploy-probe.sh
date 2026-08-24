#!/usr/bin/env bash
# Deployment ingress differential. Runs ON the deployed host, fetches each public
# route and its 127.0.0.1 equivalent, and reports when the two answers differ.
#
# WHAT THIS IS NOT. It is not an attribution mechanism. Two responses being equal
# is CORRELATION, NOT PROVENANCE: an intermediary can produce the same status the
# backend would have, and this script cannot see which component answered. An
# earlier version of this claimed otherwise ("public == local proves the funnel
# reached the backend"), and that claim was false. The predecessor to that one
# made the same category of error in the opposite direction — it read a public
# 502 as "the funnel is unpublished", restarted tailscaled, and turned a working
# ingress with a momentarily dead backend into no ingress at all. Both mistakes
# come from believing a status code names its author.
#
# So the claims here are deliberately small:
#
#   legs DIFFER      something between the two probes is not equivalent. That is
#                    a symptom worth a human. It does NOT identify the funnel:
#                    an http_proxy on the public leg, DNS, TLS, Host-dependent
#                    routing, or a state change between the two sequential
#                    requests will all produce it.
#   legs MATCH       weak evidence of health. Bodies being byte-identical makes
#                    it less likely an intermediary answered instead, because it
#                    would have to reproduce the same bytes — but "less likely"
#                    is the whole claim.
#   both unreachable the deployment is not answering at all. Says nothing about
#                    the ingress either way.
#
# It diagnoses and exits non-zero. It never restarts anything: every automated
# repair attempted on this surface has cost more than the fault it reacted to.
#
# `set -e` is deliberately NOT used: a failed assertion must be COUNTED, not
# abort the run and hide every later check. Matches voice-smoke.sh.
set -uo pipefail

HOST=${HOST:-srv1692698-agent.tailf3e897.ts.net}
WEBHOOK_PORT=${WEBHOOK_PORT:-8443}
VOICE_PORT=${VOICE_PORT:-10000}
API_PORT=${API_PORT:-8787}
BOT_PORT=${BOT_PORT:-8788}
WEBHOOK_PATH=${WEBHOOK_PATH:-/webhooks/kapso}

FAILED=0
ok ()  { printf '  ✓ %s\n' "$1"; }
bad () { printf '  ✗ %s\n     expected: %s\n     actual:   %s\n' "$1" "$2" "$3"; FAILED=$((FAILED+1)); }
eq ()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

# --max-time on every call: without it a wedged ingress does not fail the probe,
# it hangs it — a timeout with no diagnosis instead of a red check.
#
# --noproxy '*' on the LOCAL leg only, and this asymmetry is itself a limitation
# rather than a fix: it stops an ambient http_proxy from making the local leg
# measure a proxy instead of the backend, but the PUBLIC leg still honours that
# proxy. So an environment with http_proxy set can make the legs differ for a
# reason that has nothing to do with the deployment. Unset it before trusting a
# red result.
#
# Emits "<status>|<body>" so the comparison can include the bytes, not just the
# code. Two 401s with different bodies are not the same answer.
fetch_local ()  { curl -s -w '|%{http_code}' --noproxy '*' --max-time 8 \
                    -X POST -H 'content-type: application/json' -d '{}' "$1"; }
fetch_public () { curl -s -w '|%{http_code}' --max-time 15 \
                    -X POST -H 'content-type: application/json' -d '{}' "$1"; }
code_of () { printf '%s' "${1##*|}"; }
body_of () { printf '%s' "${1%|*}"; }

# compare <label> <public-url> <local-url> <expected-code>
compare () {
  local label=$1 pub=$2 loc=$3 want=$4
  local praw lraw pc lc pb lb
  praw=$(fetch_public "$pub"); lraw=$(fetch_local "$loc")
  pc=$(code_of "$praw"); lc=$(code_of "$lraw")
  pb=$(body_of "$praw"); lb=$(body_of "$lraw")

  # Checked FIRST, because 000 == 000 is agreement and would otherwise be
  # reported as a match. Nothing answered; there is no comparison to make.
  if [ "$pc" = "000" ] && [ "$lc" = "000" ]; then
    bad "$label — neither leg answered" "any response" "public=000 local=000"
    printf '     → the deployment is not answering. This says nothing about the ingress.\n'
    return
  fi

  if [ "$pc" != "$lc" ]; then
    bad "$label — the two legs differ" "same status" "public=$pc local=$lc"
    printf '     → a symptom, not a diagnosis. Candidates: the funnel, an http_proxy on the\n'
    printf '       public leg, DNS, TLS, Host-dependent routing, or a change between the two\n'
    printf '       sequential requests. This probe cannot distinguish them.\n'
  elif [ "$pb" != "$lb" ]; then
    bad "$label — same status ($pc) but different bodies" "identical bytes" "public=${#pb}B local=${#lb}B"
    printf '     → an intermediary answering in the backend'"'"'s place would look exactly like this.\n'
  else
    ok "$label — both legs returned $pc and identical bytes (${#pb}B)"
  fi

  # Independent of the comparison above: agreement is not correctness. An
  # anonymous POST that SUCCEEDS is a security regression, and it is precisely
  # what a check phrased as "is it up?" reports green.
  eq "$label — anonymous caller still gets $want" "$want" "$pc"
}

echo "▶ probing $HOST"
[ -n "${http_proxy:-${HTTP_PROXY:-}}" ] && \
  printf '  ! http_proxy is set — the public leg honours it and the local leg does not.\n    A red result may be the proxy. Unset it and re-run.\n'

compare "whatsapp webhook" \
  "https://$HOST:$WEBHOOK_PORT$WEBHOOK_PATH" \
  "http://127.0.0.1:$BOT_PORT$WEBHOOK_PATH" 401

compare "voice intake" \
  "https://$HOST:$VOICE_PORT/voice/request" \
  "http://127.0.0.1:$API_PORT/voice/request" 401

echo "▶ backend liveness"
eq "genesis-api /health is 200" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 8 "http://127.0.0.1:$API_PORT/health")"

# Self-test. A harness that cannot report red is not evidence, so prove it can —
# and prove it by asserting the COUNTER MOVED, not by eyeballing the output. The
# earlier version printed a failing line without checking FAILED had grown, which
# would have passed even if bad() were broken.
if [ "${NEGATIVE_CONTROL:-0}" = "1" ]; then
  echo "▶ NEGATIVE CONTROL"
  before=$FAILED
  compare "negative control" \
    "https://$HOST:$VOICE_PORT/voice/request" \
    "http://127.0.0.1:1/voice/request" 401
  if [ "$FAILED" -gt "$before" ]; then
    printf '  ✓ the harness reported red (FAILED %d → %d); subtracting the injected failures\n' "$before" "$FAILED"
    FAILED=$before
  else
    printf '  ✗ THE HARNESS CANNOT REPORT RED — a green run from it means nothing\n'
    FAILED=$((before + 1))
  fi
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ no differential detected, and both routes still refuse anonymous callers"
else
  echo "✗ $FAILED check(s) FAILED"
fi
exit $((FAILED > 0 ? 1 : 0))
