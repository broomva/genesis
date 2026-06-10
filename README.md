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

## Deploy (Railway)

The engine is a long-running Bun/Hono server → deploys to Railway (always-on),
not Vercel-as-a-site. `Dockerfile` + `railway.json` are included.

```bash
railway init -n genesis -w "<workspace>"
railway add -s genesis
railway variables -s genesis --set GENESIS_HOST=vercel \
  --set 'GENESIS_SANDBOX_BOOTSTRAP=[["npm","i","-g","@anthropic-ai/claude-code"]]' \
  --set GENESIS_MODEL=anthropic/claude-sonnet-4.5 \
  --set VERCEL_OIDC_TOKEN=<token>      # or a stable AI_GATEWAY_API_KEY
railway up -s genesis && railway domain -s genesis
```

`PORT` and `DATABASE_URL` (add the Postgres plugin) are injected by Railway;
without `DATABASE_URL` the store is pglite on the container fs. `idleTimeout` is
255s so microVM cold-starts don't sever the SSE stream.

## Stack

Bun · Turborepo · Biome · TypeScript · Hono. Durable spine (Trigger.dev) and the
Postgres/Drizzle soul-substrate land in later phases. Roadmap: BRO-1356 (Genesis epic).

## License

MIT
