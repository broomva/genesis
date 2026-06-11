# @genesis/chat-bot — Telegram channel (Chat SDK)

A **Chat SDK** (`vercel/chat`) bot that puts the Genesis agent in a Telegram chat.
Message the bot → the agent runs in a per-session Vercel Sandbox microVM (via the
Genesis engine) → the reply streams back into the thread.

This is the **channel front door**; Genesis is the engine. The bot is thin: it
maps a Telegram thread → a Genesis session (continuity) and streams
Genesis's `/api/chat` (AI SDK UI message stream) into `thread.post()`.

## Run (polling — no webhook, no public URL)

```bash
bun install
TELEGRAM_BOT_TOKEN=<from @BotFather> \
  GENESIS_URL=https://genesis-production-c94a.up.railway.app \
  bun apps/chat-bot/src/index.ts
```

Then DM your bot on Telegram. Each chat is its own Genesis session.

| Env | Required | Default |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — (create a bot via [@BotFather](https://t.me/BotFather)) |
| `TELEGRAM_BOT_USERNAME` | no | `genesis_bot` |
| `GENESIS_URL` | no | the live Railway deploy |
| `GENESIS_TOKEN` | no | — (bearer, if the Genesis deploy is gated) |

> The Genesis engine must have valid agent credentials (a stable
> `AI_GATEWAY_API_KEY` for the always-on Railway deploy — see the engine README).
> For a fully local demo, run Genesis in LocalHost mode (uses your local `claude`
> CLI) and set `GENESIS_URL=http://localhost:8787`.

## Architecture

`onNewMention(thread, message)` → `handleAgentMessage` → `genesisStream(/api/chat)`
→ `thread.post(asyncIterable)`. Telegram DMs route every message as a mention.
Multi-block agent narration is separated by blank lines; failures post a `⚠️`
message instead of crashing the bot.

Adding another channel (Slack/Discord/WhatsApp) = add its `@chat-adapter/*` and
register the same handler — Chat SDK normalizes the rest.
