# Genesis Telegram bot — systemd service (Linux)

Run the local Genesis stack (api + chat-bot) as an always-on **user** service:
starts at login, restarts on crash, survives reboots via lingering.

> **Use the installer.** `bun run genesis install` generates these units (with
> real paths), writes `~/.config/genesis-bot/{secrets.env,env.sh,start-*.sh}`,
> enables lingering, and starts everything. These templates are for reference /
> manual installs only.

## What the installer does (manual equivalent)

```bash
# 1. config (token 0600, env, start scripts) — see env layout below
mkdir -p ~/.config/genesis-bot/{data,state,logs} ~/.config/systemd/user

# 2. render units (replace __HOME__ / __REPO__) into the user unit dir
for svc in api bot; do
  sed -e "s#__HOME__#$HOME#g" -e "s#__REPO__#$PWD#g" \
    docs/deploy/systemd/genesis-$svc.service.template \
    > ~/.config/systemd/user/genesis-$svc.service
done

# 3. run without an active login session
loginctl enable-linger "$USER"

# 4. enable + start
systemctl --user daemon-reload
systemctl --user enable --now genesis-api.service genesis-bot.service
```

## Operate

```bash
systemctl --user status genesis-api genesis-bot       # state
systemctl --user restart genesis-bot                   # restart one
journalctl --user -u genesis-bot -f                    # logs
systemctl --user disable --now genesis-bot             # stop + unenable
```

## Security

The agent runs on the live `GENESIS_WORKSPACE` with tool access.
`GENESIS_TELEGRAM_ALLOWED_USERS` (owner chat id) is **required** for a real
workspace — without it, anyone who DMs the bot gets code execution on this
machine. The token lives in `~/.config/genesis-bot/secrets.env` (0600), never in
the unit file.

---

# Deployment ingress probe (timer)

`scripts/deploy-probe.sh` answers a question the app's own tests cannot: *is the
thing we already deployed answering, and still refusing anonymous callers?* On
its own it only answers that **at the instant someone runs it**.

That gap is why the 2026-08-24 outage was silent for 2h20m, and it is the same
shape as two other defects in this repo's history: the voice queue that recorded
requests nobody read (BRO-2284), and a sibling service whose failure receipts
accumulated for 13 days unnoticed. A detector with no consumer is decoration.

So the probe runs on a timer, and **the consumer is named**: each operator or
agent pass runs `genesis-probe-query.sh` to ask *did this break while I was not
looking?*

```bash
# render + install (same __HOME__ substitution as the units above)
install -m 0755 scripts/deploy-probe.sh          ~/.local/bin/genesis-deploy-probe.sh
install -m 0755 docs/deploy/systemd/genesis-deploy-probe-run.sh ~/.local/bin/
install -m 0755 docs/deploy/systemd/genesis-probe-query.sh      ~/.local/bin/
for u in genesis-deploy-probe.service genesis-deploy-probe.timer; do
  sed -e "s#__HOME__#$HOME#g" "docs/deploy/systemd/$u.template" \
    > "$HOME/.config/systemd/user/$u"
done
systemctl --user daemon-reload
systemctl --user enable --now genesis-deploy-probe.timer
```

## Verify it, because an unverified monitor is worse than none

```bash
systemctl --user start genesis-deploy-probe.service   # must succeed
genesis-probe-query.sh "1 hour ago"                   # must show the run

# inject a real fault — a port with no funnel behind it
systemd-run --user --unit=probe-fault --setenv=VOICE_PORT=9999 --wait --collect \
  ~/.local/bin/genesis-deploy-probe-run.sh
journalctl --user -u probe-fault | grep FAILED       # must show the failure
```

The middle step is not optional. The first install of this looked healthy —
`systemctl --user list-timers` showed it armed — while every run exited 127
before printing anything.

## Deliberately absent

**No remediation.** The probe never restarts anything. The predecessor to this
read a public 502 as "the funnel is unpublished", restarted `tailscaled`, and
turned a working ingress with a briefly-dead backend into no ingress at all. The
repair cost more than the fault. Diagnosis goes to a human; the human decides.

**No `Persistent=true`.** A catch-up burst after downtime would probe an ingress
that is still coming up and record failures that mean nothing.

---

# Deployment watch

`genesis-watch.sh` answers *is the deployment healthy?* in one command, on the host.

```bash
install -m 0755 docs/deploy/systemd/genesis-watch.sh ~/.local/bin/
genesis-watch.sh                       # default window: 20 min ago
WINDOW="24 hours ago" genesis-watch.sh # widen it
```

## Why a script, when the checks are five journalctl lines

They were five journalctl lines, retyped every pass for a day, and that is how a
real defect got in: `journalctl --since '23:40'` means **today** at 23:40, so
after midnight it names a *future* window and returns nothing. Several
"0 warnings / 0 leaks" readings were an empty query rather than a measurement.
They happened to be correct, which is the worst case — **a check that can only
return clean is not a check.**

So every window here is relative (`20 min ago`), which cannot invert at a date
boundary, and the counts that must never be nonzero — markdown leaks, OOM kills —
are taken over the **whole journal**, so they cannot be quietly scoped away by a
narrow window.

The default 20-minute window is for a polling loop. **Run it at 24 hours
periodically anyway**: the first 24-hour run surfaced seven `genesis-api`
warnings and four `genesis-web` ones that every short-window pass had missed,
including `final-sigterm timed out` and two left-over `claude` processes in the
cgroup.

## Two deliberate non-failures

**A failed sibling user unit is reported, never counted.** A unit that fails on
its own schedule is not this deployment's health, and conflating them trains the
reader to ignore red.

**An exit-code line with a restart beside it is deploy churn, not a fault.**
Redeploying stops the old process — which logs `Failed with result 'exit-code'`
— and starts a new one in the same second. The check compares failures against
restarts rather than alarming on every deploy.

## Verify it, because a watch that cannot report red is worthless

```bash
NEGATIVE_CONTROL=1 genesis-watch.sh        # must print red, then exit 0
REPO=/nonexistent genesis-watch.sh         # must exit 1
```

Each branch was proven to fire before this shipped: a down unit (exit 1), the
disk threshold (exit 1), a missing repo (exit 1), the leak invariant pointed at
a present pattern (78 hits, exit 1), and the warning branch at `-p info` over 24h
(165/42/661, exit 1).

**No remediation.** It never restarts anything, for the same reason
`deploy-probe.sh` does not: every automated repair tried on this host has cost
more than the fault.
