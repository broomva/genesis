# Genesis

> The agentic engine — text in, a cared-for agent session out.

Genesis turns a chat message into a supervised coding-agent run: a **supervisor**
resolves the message to a session, a **runner** spawns a coding-agent CLI
(`claude -p --output-format stream-json`) inside an isolated git worktree on an
**ExecutionHost**, and a **projection reducer** folds the NDJSON event stream into
a live phase machine (`running · awaiting · blocked · done`) that the chat surface
renders.

Greenfield, all-TypeScript. Reuses *learnings* (not code) from Houston, Hawthorne,
and the caltext/midday agentic-service pattern.

## Architecture (Phase 1 — walking skeleton)

```
 channel ─► supervisor ─► ExecutionHost ─► runner (claude -p stream-json, worktree)
                │                                   │  NDJSON
                │                                   ▼
                └────────── reply ◄── projection reducer (running/awaiting/blocked/done)
```

| Package | Responsibility |
|---|---|
| `@genesis/projection` | NDJSON parser + the run-phase reducer (TDD'd, the make-or-break piece) |
| `@genesis/host` | `ExecutionHost` seam — `LocalHost` + `VpsHost` (microVM is Phase 4) |
| `@genesis/runner` | spawn the agent CLI in a git worktree, stream → reducer |
| `@genesis/core` | domain model + `Supervisor` (resolve → dispatch) |
| `@genesis/api` | Hono server: `/message`, live `/ws`, a local web channel, + CLI |

Host ownership determines **both** persistence and credential tier — owned hosts
(local/vps) are subscription-OAuth-clean; the microVM tier (Phase 4) is keyed.

## Develop

```bash
bun install
bun test            # all packages
bun run typecheck

# local channel (web)
PORT=8787 GENESIS_WORKSPACE=/path/to/a/git/repo bun apps/api/src/index.ts
# → http://localhost:8787

# one-shot CLI
GENESIS_WORKSPACE=/path/to/repo bun apps/api/src/cli.ts "do the thing"
```

## Install the local bot (macOS / Linux)

Run Genesis as an always-on **Telegram bot on your own machine** — the agent runs
`claude` locally via your subscription (no per-run cost), gated to your own
Telegram chat id. One command sets it up and registers a service (launchd on
macOS, systemd `--user` on Linux):

```bash
git clone https://github.com/broomva/genesis && cd genesis
bun install
bun run genesis install        # prompts for bot token, your chat id, workspace
```

Prereqs on the target machine: **bun**, the **`claude` CLI logged in** (run
`claude` once — subscription auth), and a Telegram **bot token** (from
[@BotFather](https://t.me/BotFather)) + your numeric **chat id** (from
[@userinfobot](https://t.me/userinfobot)). Non-interactive:

```bash
bun run genesis install --token <BOT_TOKEN> --owner <CHAT_ID> \
  --workspace "$HOME/projects" --port 8787
```

Manage it:

```bash
bun run genesis status      # service state
bun run genesis logs        # recent logs
bun run genesis stop|start  # control both services
bun run genesis uninstall   # remove the service (keeps your config)
```

> **Security.** The owner allowlist (`--owner`) is **required** — the agent has
> tool access to `GENESIS_WORKSPACE`, so an un-gated bot is remote code execution
> by DM. The token is written to `~/.config/genesis-bot/secrets.env` (0600),
> never into the service unit. Details: `docs/deploy/{launchd,systemd}/README.md`.

## Chat SDK channel

`POST /api/chat` speaks the **Vercel AI SDK UI message stream** protocol, so any
`useChat`/`DefaultChatTransport` client (or curl) drives Genesis directly:

```bash
curl -N -X POST localhost:8787/api/chat -H 'content-type: application/json' \
  -d '{"id":"t1","messages":[{"role":"user","parts":[{"type":"text","text":"hello"}]}]}'
```

## Execution host

`GENESIS_HOST=vercel` runs each chat thread's agent in its own per-session
**Vercel Sandbox** Firecracker microVM, routed through **Vercel AI Gateway** (no
raw `ANTHROPIC_API_KEY`). Auth: `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`
(`vercel env pull`). See `.env.example`. Default host is local (`claude` CLI).

## Self-host on your own server (free, subscription)

Run Genesis on **hardware you own** with the agent executing locally via your
Claude subscription (no per-run cost) — the "claude CLI on your own computer"
carve-out. Two ways:

- **Plain Linux server (no Docker):** the installer above — `claude login` on the
  box, then `bun run genesis install` (systemd). Simplest.
- **Coolify / docker-compose:** `docs/deploy/coolify/` — a Dockerfile that bakes
  the `claude` CLI (not credentials, non-root), a two-service compose (api
  internal-only + outbound bot), authenticated by a `CLAUDE_CODE_OAUTH_TOKEN`
  (from `claude setup-token`) set as a runtime secret — no credential file
  mounted. See `docs/deploy/coolify/README.md`.

Subscription auth is ToS-clean **only on owned hardware** — on rented/shared PaaS
use the keyed model below.

## Deploy (Railway — keyed)

The engine is a long-running Bun/Hono server → deploys to Railway (always-on),
not Vercel-as-a-site. Railway is not *your* hardware, so the agent runs in keyed
Vercel-Sandbox microVMs (`GENESIS_HOST=vercel` + `AI_GATEWAY_API_KEY`), not the
subscription. `Dockerfile` + `railway.json` are included.

```bash
railway init -n genesis -w "<workspace>"
railway add -s genesis
railway variables -s genesis --set GENESIS_HOST=vercel \
  --set 'GENESIS_SANDBOX_BOOTSTRAP=[["npm","i","-g","@anthropic-ai/claude-code"]]' \
  --set GENESIS_MODEL=anthropic/claude-sonnet-4.5 \
  --set VERCEL_OIDC_TOKEN=<token>      # smoke-test only — see note below
railway up -s genesis && railway domain -s genesis
```

> **Credential note.** `VERCEL_OIDC_TOKEN` (from `vercel env pull`) is
> **short-lived (~12h)** and will fail mid-run once it expires — use it only for a
> quick smoke. For an **always-on** deploy, set a **stable `AI_GATEWAY_API_KEY`**
> instead (mint at vercel.com → AI Gateway → API Keys). Auth is checked at boot
> only for *presence*; an expired token still boots but fails on the first agent run.

`PORT` and `DATABASE_URL` (add the Postgres plugin) are injected by Railway;
without `DATABASE_URL` the store is pglite on the container fs. `idleTimeout` is
255s so microVM cold-starts don't sever the SSE stream (`GENESIS_IDLE_TIMEOUT`
overrides; a non-numeric value falls back to 255).

## Stack

Bun · Turborepo · Biome · TypeScript · Hono. Durable spine (Trigger.dev) and the
Postgres/Drizzle soul-substrate land in later phases. Roadmap: BRO-1356 (Genesis epic).

## License

MIT
