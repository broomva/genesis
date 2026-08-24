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
COOLDOWN="${GENESIS_FUNNEL_COOLDOWN:-600}"

# A published funnel answers from the listener: 405 to GET (wrong method) or
# 401 (signature missing). Anything else -- crucially 000, a refused or timed
# out connection -- means the ingress is not serving this node.
healthy_code() { [[ "$1" == "405" || "$1" == "401" ]]; }

# 502/503 MEAN THE OPPOSITE OF UNPUBLISHED, and conflating them cost an outage.
#
# Measured, 2026-08-24 05:02:46Z. genesis-bot was restarting (a deploy), so nothing
# held 127.0.0.1:8788. The probe returned 502 on both ingresses, this guard read
# "UNHEALTHY on every public ingress" and restarted tailscaled. The post-restart
# probes returned 000 and it logged "still UNHEALTHY -- needs a human". It had taken
# a working ingress with a momentarily dead backend and made it no ingress at all.
#
# A 502 can only come FROM the ingress: tailscaled terminated the TLS, matched a
# serve rule, dialled the backend and was refused. That is proof the funnel IS
# published -- the exact condition this guard exists to detect the absence of. An
# unpublished funnel cannot produce 502; it produces 000, or a TLS failure.
#
# So restarting tailscaled here is both the wrong remedy and an actively harmful
# one, and the trigger is ordinary: any backend restart that overlaps a tick (this
# runs every 300s) reproduces it. The header above already warns that acting on a
# blip "is how a guard becomes the outage" -- this is that, one layer in.
backend_down_code() { [[ "$1" == "502" || "$1" == "503" || "$1" == "504" ]]; }

log() { echo "[funnel-guard] $*"; }

mkdir -p "$STATE_DIR"

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
backend_down=0
for ip in "${IPS[@]}"; do
  code="$(probe "$ip")"
  log "ingress $ip -> $code"
  healthy_code "$code" && ok=1
  backend_down_code "$code" && backend_down=1
done

if [ "$ok" = 1 ]; then
  log "funnel is published and serving"
  exit 0
fi

# Checked BEFORE the cooldown and the restart: a gateway error is positive evidence
# the funnel is up, so there is nothing here for a tailscaled restart to fix. Exit 1
# so the tick is visible in the journal as a real observation, not silence -- the
# unit sets SuccessExitStatus=0 1 precisely so an advisory failure does not mask the
# next one.
if [ "$backend_down" = 1 ]; then
  log "ingress is SERVING but the backend behind it refused (gateway error) --"
  log "  this is a backend outage, not a funnel one; NOT restarting tailscaled"
  exit 1
fi

now="$(date +%s)"
last="$(cat "$STATE_DIR/last-restart" 2>/dev/null || echo 0)"
since=$(( now - last ))
if [ "$since" -lt "$COOLDOWN" ]; then
  # Restarting on every tick would turn a Tailscale-side outage into a local
  # restart loop that also drops SSH, which is over the same daemon.
  log "UNHEALTHY, but tailscaled was restarted ${since}s ago (cooldown ${COOLDOWN}s) -- not restarting"
  exit 1
fi

log "UNHEALTHY on every public ingress -- restarting tailscaled"
echo "$now" > "$STATE_DIR/last-restart"
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
POST_RESTART_BUDGET="${GENESIS_FUNNEL_POST_RESTART_BUDGET:-150}"
waited=0
delay=10
while :; do
  sleep "$delay"
  waited=$(( waited + delay ))
  for ip in "${IPS[@]}"; do
    code="$(probe "$ip")"
    log "post-restart ingress $ip -> $code (${waited}s)"
    if healthy_code "$code"; then
      log "funnel RECOVERED after restart (${waited}s)"
      exit 0
    fi
  done
  [ "$waited" -ge "$POST_RESTART_BUDGET" ] && break
  # Back off, but never overshoot the budget — a 20s cap keeps the unit short-lived.
  [ "$delay" -lt 20 ] && delay=$(( delay + 5 ))
done
log "still UNHEALTHY ${waited}s after restart -- needs a human"
exit 1
