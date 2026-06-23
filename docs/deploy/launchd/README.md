# Genesis Telegram bot — launchd service (macOS)

Run the local Genesis stack (api + chat-bot, exempt interactive engine) as an
always-on macOS service: starts at login, restarts on crash, survives reboots.
(BRO-1516)

## Architecture

Two independent LaunchAgents, each `KeepAlive` + `RunAtLoad`, running wrapper
scripts from the **permanent** checkout (`~/broomva/apps/genesis`) — never a
git worktree (a removed worktree orphans the process: its cwd vanishes and it
can no longer `posix_spawn` tmux).

- `tech.broomva.genesis.api` → `start-api.sh` (the Hono/Bun api on :8787)
- `tech.broomva.genesis.bot` → `start-bot.sh` (the Telegram poller)

## Why the wrapper scripts (don't skip these)

- **PATH**: launchd's PATH is minimal (`/usr/bin:/bin:…`). The agent must find
  `tmux` (homebrew), `bun`, and `claude`, or every turn fails with
  `ENOENT … posix_spawn 'tmux'`. `env.sh` prepends the real tool dirs.
- **Token**: kept in `~/.config/genesis-bot/secrets.env` (0600), sourced with
  `set -a` so the bare `VAR=value` is exported to `exec bun`. Never put the
  token in the plist (world-readable in `~/Library/LaunchAgents`).
- **Durable dirs**: data/state live under `~/.config/genesis-bot/` (not `/tmp`,
  which is cleared on reboot — that would drop subscriptions every restart).

## Install

```bash
mkdir -p ~/.config/genesis-bot/{data,state} ~/Library/Logs
cp docs/deploy/launchd/start-api.sh docs/deploy/launchd/start-bot.sh ~/.config/genesis-bot/
cp docs/deploy/launchd/env.sh.example ~/.config/genesis-bot/env.sh
chmod +x ~/.config/genesis-bot/*.sh
# edit ~/.config/genesis-bot/env.sh — set GENESIS_TELEGRAM_ALLOWED_USERS + bot username

# render the plists (replace __HOME__) into LaunchAgents
for svc in api bot; do
  sed "s#__HOME__#$HOME#g" docs/deploy/launchd/tech.broomva.genesis.$svc.plist.template \
    > ~/Library/LaunchAgents/tech.broomva.genesis.$svc.plist
done

# load
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/tech.broomva.genesis.api.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/tech.broomva.genesis.bot.plist
```

## Operate

```bash
launchctl list | grep genesis                              # status (pid, last-exit)
launchctl kickstart -k gui/$(id -u)/tech.broomva.genesis.bot   # restart one
launchctl bootout gui/$(id -u)/tech.broomva.genesis.bot         # stop one
tail -f ~/Library/Logs/genesis-bot.log                     # logs
```

## Security

The interactive engine **auto-allows all tools + bash** on the live workspace.
`GENESIS_TELEGRAM_ALLOWED_USERS` (owner chat id) is **required** when
`GENESIS_WORKSPACE` is a real directory — without it, anyone who DMs the bot
gets RCE on this machine.
