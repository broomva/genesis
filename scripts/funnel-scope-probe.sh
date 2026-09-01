#!/usr/bin/env bash
# What does the Tailscale Funnel actually publish? (BRO-2412)
#
# A measurement, committed, because BRO-2412 flip-flopped three times on prose:
# the ticket said the root was funnelled, a later session said only /voice, and
# a third pass said the root again. None of them measured it.
#
# TWO TRAPS THIS AVOIDS, both of which have already bitten this repo:
#
#  1. MagicDNS. `srv…ts.net` resolves to the TAILNET address (100.x) on a machine
#     running tailscaled, so a plain curl measures the tailnet and proves nothing
#     about the funnel. Resolved through PUBLIC DNS and pinned with --resolve,
#     and `%{remote_ip}` is printed so the path taken is visible rather than
#     assumed. (server.ts records that the first attempt at this took the tailnet
#     path silently.)
#
#  2. A status code alone does not say WHO answered. Hono's 404 body is
#     "404 Not Found" (13 bytes); tailscaled's Go http.NotFound is
#     "404 page not found" (19 bytes). A 19-byte 404 means the FUNNEL declined to
#     route the path — the request never reached genesis — which is the scoping
#     claim. A 13-byte 404 would mean the opposite: routed, and genesis had no
#     such route.
#
# Usage:  scripts/funnel-scope-probe.sh <host.tailnet.ts.net> [funnel-port]
set -euo pipefail

HOST="${1:?usage: funnel-scope-probe.sh <host.tailnet.ts.net> [port]}"
PORT="${2:-10000}"

command -v dig >/dev/null || { echo "dig is required" >&2; exit 2; }
# Filtered to an A record: `dig +short` also emits CNAME lines, and taking one
# would produce a bogus --resolve and a confidently wrong verdict. `|| true`
# because `set -e` would otherwise kill the script before the message below.
PUB="$(dig +short @1.1.1.1 "$HOST" 2>/dev/null | grep -Eo '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)"
[ -n "$PUB" ] || { echo "no public A record for $HOST — is the funnel on?" >&2; exit 2; }
echo "public ingress for $HOST: $PUB"
echo

fail=0
PROBED=0
# The number of probes this script must run before it is allowed to say PASS.
EXPECTED_PROBES=6
printf '%-26s %-5s %-6s %-16s %s\n' PATH CODE BYTES REMOTE_IP VERDICT
probe() { # probe <path> <expect: published|declined>
  local p="$1" want="$2" out code bytes ip verdict
  PROBED=$((PROBED + 1))
  out="$(curl -s -X POST -H 'content-type: application/json' -d '{}' \
        --resolve "$HOST:$PORT:$PUB" "https://$HOST:$PORT$p" \
        -w '\n%{http_code}|%{size_download}|%{remote_ip}' --max-time 20 2>/dev/null || true)"
  code="$(printf '%s' "$out" | tail -1 | cut -d'|' -f1)"
  bytes="$(printf '%s' "$out" | tail -1 | cut -d'|' -f2)"
  ip="$(printf '%s' "$out" | tail -1 | cut -d'|' -f3)"

  # With --resolve present this is $PUB by construction, so it cannot catch a
  # tailnet detour — that is prevented upstream, not detected here. What it DOES
  # catch is a curl that produced nothing at all (empty output → empty ip →
  # mismatch → fail), which is the failure that would otherwise read as a clean
  # run of zero rows.
  if [ "$ip" != "$PUB" ]; then
    verdict="BAD: answered by $ip, not the public ingress"; fail=1
  elif [ "$code" = "404" ] && [ "$bytes" = "19" ]; then
    verdict="declined by the funnel"
  elif [ "$code" = "404" ] && [ "$bytes" = "13" ]; then
    verdict="ROUTED to genesis, which has no such route"
  else
    verdict="routed — genesis answered $code"
  fi
  printf '%-26s %-5s %-6s %-16s %s\n' "$p" "$code" "$bytes" "$ip" "$verdict"

  case "$want" in
    published) [ "$code" != "404" ] || { echo "  EXPECTED $p to be published"; fail=1; } ;;
    declined)  [ "$code" = "404" ] && [ "$bytes" = "19" ] || { echo "  EXPECTED $p to be declined BY THE FUNNEL"; fail=1; } ;;
  esac
}

# /voice is the surface ElevenLabs must reach. POST, not GET: these routes are
# POST-only, so a GET 404s whether or not the path is published and cannot
# discriminate. These two are gated by a secret, so the POST is refused (401)
# rather than executed.
probe /voice/identify published
probe /voice/request  published

# NON-EXISTENT SUBPATHS, deliberately. The earlier version POSTed to the real
# owner routes — and in the failure case this script exists to detect (a
# root-wide funnel) those POSTs REACH Genesis, where `unauthorized()` fails open
# on an unset token. `POST /workspaces/refresh` would then execute
# `reloadWorkspaces()`, and `POST /message` was saved only by an empty-body guard
# sitting in front of `dispatch`. A diagnostic must not be able to act on the
# system it is diagnosing, least of all when that system is broken.
#
# The discriminator is unchanged: funnel-declined is still tailscaled's 19-byte
# body, and a ROUTED request now meets Hono's own 13-byte 404 because no such
# route exists. Both outcomes are readable; neither runs a handler.
probe /message/__scope_probe__            declined
probe /control/__scope_probe__            declined
probe /workspaces/refresh/__scope_probe__ declined
probe /walkie/asks/__scope_probe__        declined

echo
# ARITY. Delete every `probe` call and this script printed an empty table and a
# confident PASS with exit 0 — measuring nothing, while the test that guards it
# stayed green because everything it counts lives inside `probe()` itself. The
# sibling mutation sweep has carried this exact guard for the same reason since
# it was written; this script did not.
if [ "$PROBED" -ne "$EXPECTED_PROBES" ]; then
  echo "REFUSING: $PROBED probes ran, expected $EXPECTED_PROBES — this run measured less than it claims"
  exit 2
fi
if [ "$fail" -eq 0 ]; then
  echo "PASS: on :$PORT the funnel publishes /voice and declines everything else"
else
  echo "FAIL: the funnel's scope is not what this repo documents"
fi
exit "$fail"
