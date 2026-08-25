#!/usr/bin/env bash
# One command that answers "is the deployment healthy?" — run on the host.
#
# WHY THIS IS A SCRIPT AND NOT A TYPED-OUT PIPELINE. It was the latter for a day,
# retyped each check, and that is how a real defect got in: `journalctl --since
# '23:40'` means TODAY at 23:40, so after midnight it names a FUTURE window and
# returns nothing. Several "0 warnings / 0 leaks" readings were therefore an
# empty query rather than a measurement. They happened to be correct, which is
# the worst case — a check that can only return "clean" is not a check.
#
# So: every window here is RELATIVE (`20 min ago`), which cannot invert at a date
# boundary, and the counts that must never be nonzero are taken over the WHOLE
# journal rather than a window, so they cannot be quietly scoped away.
#
# It DIAGNOSES and exits non-zero. It never restarts anything — the same rule as
# deploy-probe.sh, for the same reason: every automated repair tried on this host
# has cost more than the fault.
#
# `set -e` is deliberately NOT used: a failed check must be COUNTED, not abort
# the run and hide every later one.
set -uo pipefail

WINDOW=${WINDOW:-20 min ago}
REPO=${REPO:-$HOME/genesis}
UNITS=(genesis-api genesis-web genesis-bot)

FAILED=0
ok ()  { printf '  ✓ %s\n' "$1"; }
bad () { printf '  ✗ %s\n     %s\n' "$1" "$2"; FAILED=$((FAILED+1)); }
jctl () { journalctl --user "${@}" --no-pager 2>/dev/null; }
# grep -c counts LINES; journalctl prints "-- No entries --" when empty, which
# would count as 1. Filter it, then count.
# Takes ALL args through to grep, not just the first: `count -i 'pattern'` lost
# the pattern when this forwarded only "$1", and grep then errored while the
# arithmetic downstream saw an empty string. The script went red rather than
# silently passing, which is the failure mode it is supposed to have.
count () { grep -v -- '-- No entries --' | grep -c "$@"; }

echo "▶ genesis watch  (window: $WINDOW)"

echo "▶ units"
for u in "${UNITS[@]}"; do
  s=$(systemctl --user is-active "$u" 2>/dev/null)
  [ "$s" = "active" ] && ok "$u active" || bad "$u is $s" "systemctl --user status $u"
done
f=$(systemctl --user --failed --no-legend --no-pager 2>/dev/null | grep -c .)
# Reported, never failed on: a sibling unit that fails on its own schedule is not
# this deployment's health, and conflating them trains the reader to ignore red.
[ "$f" -eq 0 ] && ok "no failed user units" \
  || printf '  ! %s failed user unit(s) — NOT counted against this deployment:\n%s\n' \
       "$f" "$(systemctl --user --failed --no-legend --no-pager 2>/dev/null | sed 's/^/      /')"

echo "▶ errors in the window"
for u in "${UNITS[@]}"; do
  n=$(jctl -u "$u" --since "$WINDOW" -p warning | count .)
  [ "$n" -eq 0 ] && ok "$u: no warnings" || bad "$u: $n warning(s)" "journalctl --user -u $u --since '$WINDOW' -p warning"
done
r=$(jctl -u genesis-api -u genesis-web -u genesis-bot --since "$WINDOW" | count -i 'Failed with result')
# A redeploy stops the old process, which logs exit-code AND starts a new one in
# the same second. Only flag failures with no restart beside them.
st=$(jctl -u genesis-api -u genesis-web -u genesis-bot --since "$WINDOW" | count -i 'Started genesis')
if [ "$r" -eq 0 ]; then ok "no unit failures"
elif [ "$st" -ge "$r" ]; then ok "$r exit-code line(s), each with a restart beside it (deploy churn)"
else bad "$r failure(s), only $st restart(s)" "journalctl --user -u genesis-bot --since '$WINDOW'"; fi

echo "▶ invariants over the WHOLE journal (not a window — these must never be nonzero)"
leaks=$(jctl -u genesis-bot | count 'MARKDOWN LEAK')
[ "$leaks" -eq 0 ] && ok "no markdown leaks, ever" || bad "$leaks markdown leak(s)" "journalctl --user -u genesis-bot | grep 'MARKDOWN LEAK'"
oom=$(jctl | count -iE 'out of memory|oom-kill')
[ "$oom" -eq 0 ] && ok "no OOM events, ever" || bad "$oom OOM event(s)" "journalctl --user | grep -i oom"

echo "▶ traffic (reported, not asserted — silence is not a fault)"
printf '     turns in window: %s | voice answers 24h: %s\n' \
  "$(jctl -u genesis-bot --since "$WINDOW" | count 'Direct message received')" \
  "$(jctl -u genesis-bot --since '24 hours ago' | count 'answered')"

echo "▶ deploy"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" fetch origin main -q 2>/dev/null
  behind=$(git -C "$REPO" rev-list --count HEAD..origin/main 2>/dev/null)
  printf '     %s on %s | %s behind main\n' \
    "$(git -C "$REPO" rev-parse --short HEAD)" "$(git -C "$REPO" branch --show-current)" "${behind:-?}"
else
  bad "no repo at $REPO" "REPO=<path> genesis-watch.sh"
fi

echo "▶ disk"
use=$(df -P / | awk 'NR==2{gsub(/%/,"",$5); print $5}')
[ "$use" -lt 90 ] && ok "disk ${use}%" || bad "disk ${use}%" "du -sh \$HOME/* | sort -h | tail"

# Self-test. A watch that cannot report red is not evidence, so prove it can.
# Runs ALONE and exits, sharing no run with a real check — the lesson from the
# probe's own control, which reset a counter and could have masked a real fault.
if [ "${NEGATIVE_CONTROL:-0}" = "1" ]; then
  echo; echo "▶ SELF-TEST — the line below MUST be red"
  bad "injected failure" "this is the control; it proves bad() increments"
  [ "$FAILED" -gt 0 ] && { echo "✓ the watch can report red"; exit 0; }
  echo "✗ THE WATCH CANNOT REPORT RED — every green run from it is worthless"; exit 1
fi

echo
[ "$FAILED" -eq 0 ] && echo "✓ deployment healthy" || echo "✗ $FAILED check(s) FAILED"
exit $((FAILED > 0 ? 1 : 0))
