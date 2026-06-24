# Genesis self-host — private server / Coolify (subscription, free)

Run Genesis on **your own Linux server** with the agent executing **locally via
your Claude subscription** (no per-run cost). Auth is by a long-lived **token**
(not a mounted credential file), so nothing secret lives in git or the image.

## Pick your path

| Path | When | Status |
|---|---|---|
| **Plain Linux server, no Docker** (the installer) | You just want it running on a Linux box | ✅ **Recommended & tested** |
| **Coolify / docker-compose** (this dir) | You want it containerized / managed by Coolify | ⚠️ **Build-verify required** (see checklist) |
| Railway / shared PaaS | Not your hardware | Use the **keyed** model (repo-root `Dockerfile` + `GENESIS_HOST=vercel`) |

### Recommended: plain Linux server (no container)

This is the simplest owned-hardware path and it's the tested one:

```bash
# on the server:
curl -fsSL https://claude.ai/install.sh | bash    # install Claude Code
claude                                             # log in (paste-code flow works over SSH)
git clone https://github.com/broomva/genesis && cd genesis
bun install
bun run genesis install                            # systemd service, GENESIS_HOST=local
```

`genesis install` writes the service + secrets and starts it (see the root README).
Free, subscription, owner-allowlisted. No Docker needed.

---

## Coolify / docker-compose

Containerized variant. Two services from one image on a private network:

```
Telegram ⇄ bot ──HTTP (Bearer GENESIS_TOKEN)──► api ──spawns──► claude -p (subscription)
          (outbound poll,                        (INTERNAL ONLY,    on /workspace
           owner-allowlisted,                       never published)
           fail-closed)
```

### 1. Get a subscription token (once, on any machine with a browser)

```bash
claude setup-token        # walks OAuth, PRINTS a 1-year token (does not save it)
```

Copy the printed token → it becomes `CLAUDE_CODE_OAUTH_TOKEN`. This is the
container/CI auth path; no credential file is mounted.

### 2A. Coolify

1. **New Resource → Docker Compose**, point at this repo, compose path
   `docs/deploy/coolify/docker-compose.yml` (Base Directory = repo root).
2. Set **Environment Variables** (see `.env.example`): `CLAUDE_CODE_OAUTH_TOKEN`,
   `TELEGRAM_BOT_TOKEN`, `GENESIS_TELEGRAM_ALLOWED_USERS` (your chat id),
   `GENESIS_TOKEN` (`openssl rand -hex 32`), `GENESIS_WORKSPACE_HOST` (host path
   to the repos the agent may edit), optionally `CLAUDE_VERSION`.
3. **Do NOT attach a public domain to the `api` service.** The api is an
   unauthenticated agent with `--dangerously-skip-permissions` — a domain on it
   publishes RCE to the internet. (A domain on `bot` is unnecessary too; it polls
   outbound.) This is the one human-discipline gate Coolify can't enforce for you.
4. Deploy. The `bot` waits for the `api` healthcheck, then DM your bot.

### 2B. plain docker compose

```bash
cd docs/deploy/coolify
cp .env.example .env && edit .env        # fill the required vars
docker compose up -d --build
docker compose logs -f bot               # allowlist line + polling
```

## Operate

```bash
docker compose ps
docker compose logs -f api               # engine + dispatch traces
docker compose logs -f bot
docker compose restart bot
docker compose down                      # stop (data volumes preserved)
```

## Upgrade

In-container auto-update is **disabled** for determinism. Bump `CLAUDE_VERSION`
(or keep `stable`) and `docker compose up -d --build` to upgrade Claude Code;
pull the repo + rebuild to upgrade Genesis.

## ⚠️ Build-verify checklist (run these once on your Docker host)

This image was **not built in CI** (no Docker available there). It's reviewed and
the auth/security design is verified against the Claude Code docs, but confirm the
operational bits on your host before relying on it:

1. **Image builds:** `docker compose build` — confirms the native `claude`
   installer runs as the non-root `bun` user in the `oven/bun` (Debian/glibc) image.
2. **Workspace bind is writable by uid 1000:** the container runs as the non-root
   `bun` user (uid 1000). Your `GENESIS_WORKSPACE_HOST` must be owned/writable by
   uid 1000, or the agent gets permission errors on `/workspace`
   (`sudo chown -R 1000:1000 <path>`, or deploy from a uid-1000 account).
3. **Token auth works:** `docker compose exec api sh -lc 'claude -p "say hi"'`
   should answer using `CLAUDE_CODE_OAUTH_TOKEN` (no login prompt).
4. **Workspace is a git repo:** the agent's first real task expects `/workspace`
   to be a git checkout — confirm `GENESIS_WORKSPACE_HOST` points at one.

## Security invariants

- **api never published** — no `ports:`; internal network only. Never add a
  Coolify domain to it. (`/health` is open and reveals the workspace path — one
  more reason not to expose the api.)
- **`GENESIS_TOKEN`** gates `/message` + `/threads` (Bearer). Always set it.
- **Owner allowlist fail-closed** — the bot refuses to start without
  `GENESIS_TELEGRAM_ALLOWED_USERS`.
- **Subscription on owned hardware only** — the "claude on your own computer"
  carve-out. Don't use subscription auth on rented/shared PaaS.
- Token + creds live in env / runtime secrets, **never** in the image or git.
