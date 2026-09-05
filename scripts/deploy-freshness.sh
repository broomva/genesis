#!/usr/bin/env bash
# Is the deployment RUNNING what main says? Separate from deploy-probe.sh's
# ingress legs, which answer "is it answering" — a different question that was
# green for 7d20h while this host served a checkout 16 commits behind.
#
# Standalone and parameterised ON PURPOSE. The first version lived inline in
# deploy-probe.sh and its tests were greps over the file's text; a sweep showed
# 12 of 15 wrong implementations passing, including wrapping the whole section in
# `if false &&`. A script that can be pointed at a fixture repo with a shimmed
# `systemctl` can be tested on BEHAVIOUR, and that is the only reason this is a
# separate file.
#
#   REPO_DIR   the checkout the units execute from (default: $PWD)
#   SKIP_FETCH set to 1 to skip the network call (tests)
#
# Exits 0 when every claim holds, 1 otherwise, 2 when it declines to answer.
set -uo pipefail

# systemd renders timestamps through strftime in the caller's locale, so a
# non-English LC_TIME made every unit fail to parse. Forced, not assumed.
export LC_ALL=C

RD="${REPO_DIR:-$PWD}"
FAILED=0
ok ()  { printf '  ✓ %s\n' "$1"; }
bad () { printf '  ✗ %s\n     expected: %s\n     actual:   %s\n' "$1" "$2" "$3"; FAILED=$((FAILED+1)); }

gap () {
  local sec=$1
  if   [ "$sec" -ge 172800 ]; then echo "$((sec / 86400))d"
  elif [ "$sec" -ge 7200 ];   then echo "$((sec / 3600))h"
  elif [ "$sec" -ge 120 ];    then echo "$((sec / 60))m"
  else echo "${sec}s"; fi
}

# `date -d` is GNU-only — BSD date rejects it — and `date -d ""` on GNU returns
# TODAY AT MIDNIGHT with exit 0, which is how an unstarted unit read as fresh.
# python3 parses explicitly and fails loudly on anything it does not recognise.
epoch_of () {
  python3 - "$1" <<'PY' 2>/dev/null
import sys, datetime
s = sys.argv[1].strip()
if not s or s in ("n/a", "0"):
    sys.exit(1)
# systemd: "Mon 2026-08-24 23:44:41 -05" (weekday optional, offset optional)
parts = s.split()
if parts and not parts[0][0].isdigit():
    parts = parts[1:]
if not parts:
    sys.exit(1)
base = " ".join(parts[:2])
try:
    dt = datetime.datetime.strptime(base, "%Y-%m-%d %H:%M:%S")
except ValueError:
    sys.exit(1)
if len(parts) > 2:
    off = parts[2]
    try:
        sign = 1 if off[0] == "+" else -1
        digits = off[1:].replace(":", "")
        hours = int(digits[:2]); mins = int(digits[2:4]) if len(digits) > 2 else 0
        dt = dt.replace(tzinfo=datetime.timezone(sign * datetime.timedelta(hours=hours, minutes=mins)))
    except (ValueError, IndexError):
        dt = dt.replace(tzinfo=datetime.timezone.utc)
else:
    dt = dt.replace(tzinfo=datetime.timezone.utc)
print(int(dt.timestamp()))
PY
}

UNIT_PATHS=(
  "genesis-api:apps/api packages"
  "genesis-bot:apps/chat-bot packages"
  "genesis-web:apps/web packages"
)

# DECLINE rather than measure the wrong machine. Off the deployed host the
# checkout in scope is the developer's, and reporting its freshness answers about
# the wrong machine in the reassuring direction.
if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user cat genesis-api.service >/dev/null 2>&1; then
  printf '  – freshness NOT assessed: no genesis-api user unit here, so this is not the deployed host\n'
  exit 2
fi
if [ ! -e "$RD/.git" ]; then
  printf '  – freshness NOT assessed: %s is not a checkout\n' "$RD"
  exit 2
fi

# --- checkout currency -------------------------------------------------------
# The fetch is bounded. deploy-probe.sh's own doctrine is that a wedged network
# must fail the probe rather than hang it, and every curl there obeys it; the
# first version of this network call did not, and an unreachable origin hung the
# run with no diagnosis. GIT_TERMINAL_PROMPT stops a credential helper blocking
# on /dev/tty, which `2>/dev/null` hides rather than prevents.
if [ "${SKIP_FETCH:-0}" != "1" ]; then
  if ! GIT_TERMINAL_PROMPT=0 timeout 30 git -C "$RD" fetch -q origin 2>/dev/null; then
    bad "origin is reachable to assess freshness" "fetch succeeds within 30s" "fetch failed or timed out"
  fi
fi

# Three separate questions, because "current" fails in three directions and the
# first version only asked one of them: it counted commits BEHIND, so an unpushed
# hotfix and a dirty tree both read as "at origin/main". On a host where agents
# edit files in place, divergence is the realistic shape of "not current".
behind=$(git -C "$RD" rev-list --count HEAD..origin/main 2>/dev/null || echo unknown)
ahead=$(git -C "$RD" rev-list --count origin/main..HEAD 2>/dev/null || echo unknown)
dirty=$(git -C "$RD" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
[ "$behind" = "0" ] && ok "checkout is not behind origin/main" \
  || bad "checkout is not behind origin/main" "0 commits behind" "$behind commits behind"
[ "$ahead" = "0" ] && ok "checkout has nothing origin/main lacks" \
  || bad "checkout has nothing origin/main lacks" "0 commits ahead" "$ahead commits ahead — diverged from main"
[ "$dirty" = "0" ] && ok "checkout is clean" \
  || bad "checkout is clean" "no modified files" "$dirty modified file(s) — edited in place"

# --- process currency, per unit ---------------------------------------------
checked=0
for unit_paths in "${UNIT_PATHS[@]}"; do
  unit=${unit_paths%%:*}
  paths=${unit_paths#*:}
  # MISSING IS A FAILURE, not a skip. The first version `continue`d, so a renamed
  # or uninstalled unit vanished from the output while the summary went on
  # claiming the host was current — worse than not checking at all.
  if ! systemctl --user cat "$unit.service" >/dev/null 2>&1; then
    bad "$unit is installed" "a $unit.service user unit" "no such unit"
    continue
  fi
  state=$(systemctl --user show "$unit.service" -p ActiveState --value 2>/dev/null || echo "")
  if [ "$state" != "active" ]; then
    # A unit that never started has no ActiveEnterTimestamp, and the currency
    # comparison would read it as fresh. Down is its own failure anyway.
    bad "$unit is active" "active" "${state:-unknown}"
    checked=$((checked+1))
    continue
  fi
  started=$(systemctl --user show "$unit.service" -p ActiveEnterTimestamp --value 2>/dev/null || echo "")
  started_epoch=$(epoch_of "$started")
  # shellcheck disable=SC2086
  touched=$(git -C "$RD" log -1 --format=%ct -- $paths 2>/dev/null || echo "")
  if [ -z "${started_epoch:-}" ] || [ -z "${touched:-}" ]; then
    bad "$unit is running its current sources" "comparable timestamps" \
        "start='${started}' parsed='${started_epoch:-}' last-touch='${touched:-}'"
  elif [ "$started_epoch" -ge "$touched" ]; then
    ok "$unit started after the last commit touching its sources"
  else
    bad "$unit is running its current sources" "restarted after its sources last changed" \
        "started $(gap $((touched - started_epoch))) before its last source commit — pulled, never restarted"
  fi
  checked=$((checked+1))
done
[ "$checked" -eq "${#UNIT_PATHS[@]}" ] || bad "every unit was assessed" \
  "${#UNIT_PATHS[@]} units" "$checked assessed"

# --- the web BUILD, which is what web actually serves ------------------------
# A restart without a rebuild reads as current from the process check alone.
# BUILD_ID is a FILE rewritten by every build; the parent directory's mtime only
# tracks direct-child churn, so an in-place rebuild left it unchanged and a
# stray `touch` made it fresh forever.
BID="$RD/apps/web/.next/BUILD_ID"
web_touched=$(git -C "$RD" log -1 --format=%ct -- apps/web packages 2>/dev/null || echo "")
if [ ! -f "$BID" ]; then
  # ABSENT IS A FAILURE. The likeliest reason for no build artifact is that the
  # build never ran, which is the condition under test — skipping here deleted
  # the claim exactly when it mattered.
  bad "apps/web has a build to serve" "apps/web/.next/BUILD_ID" "missing"
elif [ -z "${web_touched:-}" ]; then
  bad "apps/web build is newer than its sources" "a comparable commit time" "none"
else
  built=$(python3 -c 'import os,sys;print(int(os.stat(sys.argv[1]).st_mtime))' "$BID" 2>/dev/null || echo "")
  if [ -z "${built:-}" ]; then
    bad "apps/web build is newer than its sources" "a readable mtime" "unreadable"
  elif [ "$built" -ge "$web_touched" ]; then
    ok "apps/web build is newer than its sources"
  else
    bad "apps/web build is newer than its sources" "rebuilt after apps/web last changed" \
        "build is $(gap $((web_touched - built))) older than its last source commit"
  fi
fi

exit $((FAILED > 0 ? 1 : 0))
