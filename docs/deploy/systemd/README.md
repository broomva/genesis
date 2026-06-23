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
