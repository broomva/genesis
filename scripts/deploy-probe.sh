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

# Renders a seconds gap as the largest sensible unit. "0d before its last source
# commit" is what this replaced, which reads like the probe is broken.
gap () {
  local sec=$1
  if   [ "$sec" -ge 172800 ]; then echo "$((sec / 86400))d"
  elif [ "$sec" -ge 7200 ];   then echo "$((sec / 3600))h"
  elif [ "$sec" -ge 120 ];    then echo "$((sec / 60))m"
  else echo "${sec}s"; fi
}

TMPD=$(mktemp -d /tmp/deploy-probe.XXXXXX) || { echo "✗ could not create a temp dir"; exit 1; }
trap 'rm -rf "$TMPD"' EXIT

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
# The body goes to a FILE and is compared byte-for-byte with cmp, never through
# a shell variable. `$(...)` strips trailing newlines and cannot carry NUL, and ${#var}
# counts characters rather than bytes — so a shell-string comparison would report
# "identical" for bodies that differ, which is exactly the false green this probe
# exists to avoid. cmp reads the files themselves.
# Prints the status code; writes the body to $2.
fetch_local ()  { curl -s -o "$2" -w '%{http_code}' --noproxy '*' --max-time 8 \
                    -X POST -H 'content-type: application/json' -d '{}' "$1"; }
fetch_public () { curl -s -o "$2" -w '%{http_code}' --max-time 15 \
                    -X POST -H 'content-type: application/json' -d '{}' "$1"; }
size_of () { wc -c < "$1" | tr -d ' '; }

# compare <label> <public-url> <local-url> <expected-code>
compare () {
  local label=$1 pub=$2 loc=$3 want=$4
  local pc lc pf lf
  pf="$TMPD/public.body"; lf="$TMPD/local.body"
  pc=$(fetch_public "$pub" "$pf"); lc=$(fetch_local "$loc" "$lf")

  # Checked FIRST, because 000 == 000 is agreement and would otherwise be
  # reported as a match. Nothing answered; there is no comparison to make.
  if [ "$pc" = "000" ] && [ "$lc" = "000" ]; then
    bad "$label — neither leg answered" "any response" "public=000 local=000"
    printf '     → neither request received an HTTP status. Says nothing about which\n'
    printf '       component is at fault, or whether one is reachable by another route.\n'
    return
  fi

  if [ "$pc" != "$lc" ]; then
    bad "$label — the two legs differ" "same status" "public=$pc local=$lc"
    printf '     → a symptom, not a diagnosis. Candidates: the funnel, an http_proxy on the\n'
    printf '       public leg, DNS, TLS, Host-dependent routing, or a change between the two\n'
    printf '       sequential requests. This probe cannot distinguish them.\n'
  elif ! cmp -s "$pf" "$lf"; then
    bad "$label — same status ($pc) but different bodies" "identical bytes" \
        "public=$(size_of "$pf")B local=$(size_of "$lf")B"
    printf '     → an intermediary answering in the backend'"'"'s place would look exactly like this.\n'
  else
    ok "$label — both legs returned $pc, bodies byte-identical ($(size_of "$pf")B)"
  fi

  # Independent of the comparison above: agreement is not correctness. An
  # anonymous POST that SUCCEEDS is a security regression, and it is precisely
  # what a check phrased as "is it up?" reports green.
  eq "$label — anonymous caller still gets $want" "$want" "$pc"
}

# ── Self-test ──────────────────────────────────────────────────────────────
# A harness that cannot report red is not evidence. NEGATIVE_CONTROL=1 runs ONLY
# this and exits — it never shares a run with a real probe.
#
# Two earlier designs of this were wrong in the same way. The first printed a
# failing line without checking the counter moved, so it would have passed even
# if bad() were broken. The second checked the counter but aimed a leg at a live
# endpoint and then reset FAILED, so a genuine failure during the control's own
# request would have been discarded. Both leaked between the control and the
# measurement. Keeping them in separate runs removes the category: nothing real
# is probed here, so there is nothing to subtract and nothing that can be masked.
#
# Both ports are closed, which exercises the neither-answered arm. That proves
# bad() increments and the exit code follows it — it does NOT exercise the
# divergence arm, and this says so rather than implying wider coverage.
if [ "${NEGATIVE_CONTROL:-0}" = "1" ]; then
  echo "▶ SELF-TEST — the run below MUST report red"
  compare "self-test (both ports closed)" \
    "http://127.0.0.1:1/voice/request" \
    "http://127.0.0.1:1/voice/request" 401
  echo
  if [ "$FAILED" -gt 0 ]; then
    echo "✓ the harness reported red ($FAILED failure(s)) — a green run from it means something"
    exit 0
  fi
  echo "✗ THE HARNESS CANNOT REPORT RED — every green run from it is worthless"
  exit 1
fi

echo "▶ probing $HOST"
# The public leg is HTTPS, so https_proxy/HTTPS_PROXY govern it — the first
# version watched only http_proxy and would have stayed silent in the case it
# was written for. ALL_PROXY covers both.
for v in https_proxy HTTPS_PROXY http_proxy HTTP_PROXY all_proxy ALL_PROXY; do
  if [ -n "${!v:-}" ]; then
    printf '  ! %s is set — the public leg honours it, the local leg bypasses it.\n    A red result may be the proxy. Unset it and re-run.\n' "$v"
    break
  fi
done

compare "whatsapp webhook" \
  "https://$HOST:$WEBHOOK_PORT$WEBHOOK_PATH" \
  "http://127.0.0.1:$BOT_PORT$WEBHOOK_PATH" 401

compare "voice intake" \
  "https://$HOST:$VOICE_PORT/voice/request" \
  "http://127.0.0.1:$API_PORT/voice/request" 401

echo "▶ backend liveness"
eq "genesis-api /health is 200" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 8 "http://127.0.0.1:$API_PORT/health")"

echo "▶ deployment freshness"
#
# A liveness probe reports green on a deployment that is answering perfectly and
# is six months old. That is not hypothetical here: on 2026-09-01 this host was
# found serving a checkout SIXTEEN commits behind origin/main, having run for
# 7d20h. Every ingress leg above passed the whole time, because every one of them
# was true. The walkie arc — the ask log, /walkie/asks, /walkie/answer, the read
# mirrors — had been merged for days and was returning 404 in production, and
# nothing in this file could have said so.
#
# Two SEPARATE claims, because they fail independently and a deploy that does the
# first without the second is the likelier accident:
#
#   checkout currency  the working tree is at origin/main
#   process currency   the RUNNING process started after that commit, i.e. someone
#                      actually restarted the unit rather than only pulling
#
# WHAT THIS IS NOT: it is not a claim that the deployed code is correct, tested,
# or that origin/main is a good thing to be running. It answers "is this host
# running what main says" and nothing else.
FRESHNESS_ASSESSED=0
if systemctl --user cat genesis-api.service >/dev/null 2>&1 && [ -d "${REPO_DIR:-$PWD}/.git" ]; then
  FRESHNESS_ASSESSED=1
  RD="${REPO_DIR:-$PWD}"

  # The fetch is NOT optional and this is the whole trap. `git rev-list
  # HEAD..origin/main` counts against the LOCAL origin/main ref, which is only as
  # current as the last fetch — so on a host that has not fetched, a stale
  # deployment UNDER-REPORTS its own staleness. Measured on this host the same
  # minute: 12 commits behind before the fetch, 16 after. A freshness check that
  # skips the fetch is a freshness check that lies in the reassuring direction.
  if git -C "$RD" fetch -q origin 2>/dev/null; then
    behind=$(git -C "$RD" rev-list --count HEAD..origin/main 2>/dev/null || echo unknown)
    eq "checkout is at origin/main" "0 commits behind" "$behind commits behind"

    # Process currency, PER UNIT. The first version of this checked genesis-api
    # only, and the deploy that motivated the whole check then produced the exact
    # state it could not see: api restarted and CURRENT, bot and web still running
    # code from 8 days earlier out of a checkout that had already moved. It would
    # have reported "the host is running origin/main" — true of the checkout,
    # false of two of the three things serving traffic.
    #
    # Compared against the last commit touching each unit's OWN paths rather than
    # against HEAD, so a unit whose sources did not change is not reported stale.
    # Over-reporting is the safer bias for a detector, but it is also the bias
    # that gets detectors ignored.
    #
    # KNOWN LIMIT, stated rather than papered over: genesis-web serves a BUILT
    # artifact (Next standalone). Restart time is a proxy for build time, so a
    # restart without a rebuild reads as current here. The .next/standalone mtime
    # is checked separately for that reason.
    for unit_paths in "genesis-api:apps/api packages" \
                      "genesis-bot:apps/chat-bot packages" \
                      "genesis-web:apps/web packages"; do
      unit=${unit_paths%%:*}
      paths=${unit_paths#*:}
      systemctl --user cat "$unit.service" >/dev/null 2>&1 || continue
      started=$(systemctl --user show "$unit.service" -p ActiveEnterTimestamp --value 2>/dev/null)
      started_epoch=$(date -d "$started" +%s 2>/dev/null || echo 0)
      # shellcheck disable=SC2086
      touched=$(git -C "$RD" log -1 --format=%ct -- $paths 2>/dev/null || echo 0)
      if [ "$started_epoch" -eq 0 ] || [ "$touched" -eq 0 ]; then
        bad "$unit is running its current sources" "comparable timestamps" \
            "start=$started last-touch=$touched"
      elif [ "$started_epoch" -ge "$touched" ]; then
        ok "$unit started after the last commit touching its sources"
      else
        bad "$unit is running its current sources" \
            "restarted after its sources last changed" \
            "started $(gap $((touched - started_epoch))) before its last source commit — pulled, never restarted"
      fi
    done

    # genesis-web serves a build, not the checkout. A rebuild that never happened
    # is invisible to the restart check above.
    SA="$RD/apps/web/.next/standalone"
    if [ -d "$SA" ]; then
      built=$(stat -c %Y "$SA" 2>/dev/null || echo 0)
      web_touched=$(git -C "$RD" log -1 --format=%ct -- apps/web packages 2>/dev/null || echo 0)
      if [ "$built" -ge "$web_touched" ] && [ "$built" -ne 0 ]; then
        ok "apps/web standalone build is newer than its sources"
      else
        bad "apps/web standalone build is newer than its sources" \
            "rebuilt after apps/web last changed" \
            "build is $(gap $((web_touched - built))) older than its last source commit"
      fi
    fi
  else
    bad "origin is reachable to assess freshness" "fetch succeeds" "fetch failed"
  fi
else
  # Deliberately not silent, and deliberately not a pass. Run from a laptop, the
  # git checkout in scope is the DEVELOPER'S, not the deployment's — measuring it
  # would report the wrong machine's freshness in the reassuring direction. So the
  # check declines to answer, loudly, and the summary below says it declined.
  printf '  – freshness NOT assessed: no genesis-api user unit here, so this is not the deployed host\n'
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ no differential detected, and both routes still refuse anonymous callers"
  # The summary must not imply a check that did not run.
  [ "$FRESHNESS_ASSESSED" -eq 1 ] \
    && echo "✓ and the host is running origin/main" \
    || echo "– freshness unknown (not run on the deployed host)"
else
  echo "✗ $FAILED check(s) FAILED"
fi
exit $((FAILED > 0 ? 1 : 0))
