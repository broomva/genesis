#!/usr/bin/env bash
# Tailscale Funnel publication guard (BRO-2274).
#
# WHY THIS EXISTS. A reboot leaves tailscaled believing Funnel is on while it
# has never re-registered with the Funnel ingress. Every node-side signal stays
# green -- `tailscale funnel status` prints "Funnel on", `tailscale status`
# reports Health: [] and Online: true, the serve config still carries
# AllowFunnel, and the certs are valid -- while the public ingress refuses the
# connection outright. Observed twice on 2026-08-23, each time taking the
# WhatsApp channel down silently: once for 2h20m, once until a human noticed
# their messages were unanswered.
#
# THE MEASUREMENT IS THE WHOLE POINT. The box's own resolver is MagicDNS and
# returns the TAILNET address, so curling the hostname from here (or from any
# tailnet-joined machine) reaches the listener directly over WireGuard and
# returns a healthy 405 whether or not Funnel is published. That false green is
# exactly how the first outage was declared fixed. This resolves through a
# PUBLIC resolver and pins the connection to the public ingress IP, which is
# the only path Kapso can take.
set -uo pipefail

HOST="${GENESIS_FUNNEL_HOST:-srv1692698-agent.tailf3e897.ts.net}"
PORT="${GENESIS_FUNNEL_PORT:-8443}"
PROBE_PATH="${GENESIS_FUNNEL_PATH:-/webhooks/kapso}"
# Overridable so the classification can be tested without root.
STATE_DIR="${GENESIS_FUNNEL_STATE_DIR:-/var/lib/genesis-funnel-guard}"
# The address the funnel proxies TO. Probing it is what makes the decision below
# rest on locally-verifiable evidence instead of on a status code's provenance.
LOCAL_TARGET="${GENESIS_FUNNEL_LOCAL_TARGET:-127.0.0.1:8788}"

# EVERY numeric input is validated. `[ "$x" -ge "abc" ]` does not abort under
# `set -uo pipefail` -- it fails, the `&& break` never fires, and the retry loop
# below spins forever inside a systemd oneshot. A guard that hangs is worse than one
# that is wrong, because nothing after it runs either.
num_or() { case "$1" in ''|*[!0-9]*) printf '%s' "$2";; *) printf '%s' "$1";; esac; }
COOLDOWN="$(num_or "${GENESIS_FUNNEL_COOLDOWN:-600}" 600)"
POST_RESTART_BUDGET="$(num_or "${GENESIS_FUNNEL_POST_RESTART_BUDGET:-150}" 150)"

# A published funnel answers from the listener: 405 to GET (wrong method) or
# 401 (signature missing).
healthy_code() { [[ "$1" == "405" || "$1" == "401" ]]; }

# THE DECISION NO LONGER READS MEANING INTO A STATUS CODE, and that is the third
# revision of this logic — the first two were wrong in the same WAY.
#
# The original treated everything but 405/401 as "the ingress is not serving", so a
# backend restart (a 502) got tailscaled restarted. Measured 2026-08-24 05:02:46Z:
# genesis-bot was down 96s for a deploy, the probe returned 502 on both ingresses,
# this guard restarted tailscaled, and the post-restart probes returned 000 —
# turning a working ingress with a dead backend into no ingress at all.
#
# The obvious fix was to add 502/503/504 to a "backend down" list. Cross-model review
# refused it, correctly: a 502 does not PROVE the funnel is published. Any
# intermediary can emit one — a reverse proxy in front of the host, an overloaded
# relay, a timeout. Inferring publication from a code means trusting the provenance
# of a response we cannot attribute. And enumerating codes is why each review round
# found a new one: 000, then 502, then a backend that starts answering 404 or 200.
#
# So the guard now compares TWO measurements it can attribute:
#
#   public probe   the pinned public ingress IP, the only path Kapso can take
#   local probe    127.0.0.1:<backend>, which no intermediary can be in front of
#
#   public healthy                     -> serving. Nothing to do.
#   public unhealthy + local UNHEALTHY -> the backend is down. The public failure is
#                                        explained without implicating the funnel, so
#                                        restarting tailscaled cannot help. REFUSE.
#   public unhealthy + local HEALTHY   -> the backend is fine and the public path
#                                        still fails. That is the funnel. RESTART.
#
# This holds for ANY public status code, which is the point: a code we have never
# seen lands in the second or third row on the strength of the local probe, not on an
# assumption about what the code means.
local_healthy() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    "http://${LOCAL_TARGET}${PROBE_PATH}" 2>/dev/null)"
  # ANY answer means something is listening and speaking HTTP. The backend may
  # legitimately reply 405/401/404 — what matters here is that it is not refusing.
  [ -n "$code" ] && [ "$code" != "000" ]
}

log() { echo "[funnel-guard] $*"; }

# THE COOLDOWN IS ONLY AS REAL AS THE STATE BEHIND IT (CodeRabbit, Major).
#
# `last` falls back to 0 when the file is unreadable, so `since = now - 0` always
# clears any cooldown. An unwritable or full /var/lib therefore makes the cooldown
# VACUOUS and produces a restart on every tick — the exact restart loop the cooldown
# exists to prevent, and one that "also drops SSH" by the script's own note.
#
# So the guard keeps MEASURING (the header calls that the whole point, and the probe
# is what tells an operator anything) but refuses the one irreversible action it can
# no longer rate-limit. Failing closed on the restart leaves a human able to log in;
# a restart loop takes that away.
state_ok=1
if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
  state_ok=0
  log "WARNING: state dir $STATE_DIR is unusable -- the restart cooldown cannot be"
  log "  enforced, so this run will measure but never restart tailscaled"
fi

mapfile -t IPS < <(dig +short +time=5 +tries=2 @1.1.1.1 "$HOST" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')
if [ "${#IPS[@]}" -eq 0 ]; then
  # No public record, or DNS itself is down. Restarting tailscaled would not
  # fix either, and doing it on a DNS blip is how a guard becomes the outage.
  log "no public A record for $HOST via 1.1.1.1 -- cannot measure, not acting"
  exit 0
fi

probe() {
  # curl already prints 000 on a refused or timed out connection, so an
  # '|| echo 000' fallback CONCATENATES a second one and yields 000000. That
  # still fails the equality check below, i.e. it errs safe -- but a status
  # string that is not a status is how a later reader mis-reads the log.
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    --resolve "$HOST:$PORT:$1" "https://$HOST:$PORT$PROBE_PATH" 2>/dev/null)"
  printf '%s' "${code:-000}"
}

ok=0
for ip in "${IPS[@]}"; do
  code="$(probe "$ip")"
  log "ingress $ip -> $code"
  healthy_code "$code" && ok=1
done

if [ "$ok" = 1 ]; then
  log "funnel is published and serving"
  exit 0
fi

# The public path is failing. Which half? Ask the one thing no intermediary can sit
# in front of. Checked BEFORE the cooldown and before any restart.
if ! local_healthy; then
  log "public ingress is failing, but the LOCAL backend ${LOCAL_TARGET} is not"
  log "  answering either -- the failure is explained without implicating the funnel."
  log "  NOT restarting tailscaled; fix the backend."
  exit 1
fi
log "local backend ${LOCAL_TARGET} IS answering, so the public path is the fault"

now="$(date +%s)"
last="$(num_or "$(cat "$STATE_DIR/last-restart" 2>/dev/null || echo 0)" 0)"
# A FUTURE timestamp would suppress every restart until wall time caught up, so it is
# treated as no record rather than as a very recent one. Malformed content is already
# 0 via num_or -- without it, `$(( now - x ))` aborts the script under set -u.
[ "$last" -gt "$now" ] && last=0
since=$(( now - last ))
if [ "$since" -lt "$COOLDOWN" ]; then
  # Restarting on every tick would turn a Tailscale-side outage into a local
  # restart loop that also drops SSH, which is over the same daemon.
  log "UNHEALTHY, but tailscaled was restarted ${since}s ago (cooldown ${COOLDOWN}s) -- not restarting"
  exit 1
fi

if [ "$state_ok" = 0 ]; then
  log "UNHEALTHY on every public ingress, but the cooldown state is unusable --"
  log "  NOT restarting: an unrate-limited restart loop is worse than this outage"
  exit 1
fi

# Record the attempt BEFORE acting, and VERIFY BY READ-BACK. Checking only the write
# was half a fix: a write-only file (0o200) lets `printf` succeed while the `cat`
# above fails to 0, which clears every future cooldown and restarts on every tick —
# the same unbounded loop, reached through the other half of the same file.
if ! printf '%s\n' "$now" > "$STATE_DIR/last-restart" 2>/dev/null; then
  log "cannot record the restart time in $STATE_DIR -- NOT restarting tailscaled"
  exit 1
fi
if [ "$(cat "$STATE_DIR/last-restart" 2>/dev/null || true)" != "$now" ]; then
  log "recorded the restart time but cannot read it back -- the cooldown would be"
  log "  vacuous on the next tick. NOT restarting tailscaled."
  exit 1
fi

log "UNHEALTHY on every public ingress -- restarting tailscaled"
systemctl restart tailscaled || { log "tailscaled restart FAILED"; exit 1; }

# RETRY, DON'T ASK FOR A HUMAN AFTER 20 SECONDS.
#
# Measured on the same incident: the restart at 05:02:46 WORKED, but the single probe
# round 35s later still read 000 and this logged "still UNHEALTHY -- needs a human".
# The very next tick, at 05:07:49, read 405 on both ingresses with nothing done in
# between. Re-registering with the Funnel ingress simply takes longer than 20s, so
# the guard was raising a page on its own successful heal.
#
# A false "needs a human" is not free: it is the signal an operator uses to decide
# whether to intervene, and one that cries wolf on every recovery trains them to
# ignore the one that matters.
# A WALL-CLOCK DEADLINE, not a sum of sleeps. Counting only the sleeps ignored the
# probe time -- two ingresses at --max-time 15 each -- so a "150s budget" could run
# past 400s inside a systemd oneshot.
deadline=$(( $(date +%s) + POST_RESTART_BUDGET ))
delay=10
while :; do
  sleep "$delay"
  for ip in "${IPS[@]}"; do
    code="$(probe "$ip")"
    log "post-restart ingress $ip -> $code"
    if healthy_code "$code"; then
      log "funnel RECOVERED after restart"
      exit 0
    fi
  done
  # THE SAME PREDICATE AS ABOVE. The post-restart loop used to look only for
  # 405/401, so a backend that went down during the restart window was reported as
  # "still UNHEALTHY -- needs a human" -- the very conflation this revision removes,
  # left in place one branch away from where it was fixed.
  if ! local_healthy; then
    log "post-restart: public still failing but the LOCAL backend is down too --"
    log "  not a funnel fault; stopping here rather than escalating"
    exit 1
  fi
  [ "$(date +%s)" -ge "$deadline" ] && break
  [ "$delay" -lt 20 ] && delay=$(( delay + 5 ))
done
log "still UNHEALTHY after restart (budget ${POST_RESTART_BUDGET}s) -- needs a human"
exit 1
