// Genesis Telegram channel (Chat SDK / vercel/chat).
//
// Polling mode: no webhook, no public URL — the bot connects OUT to Telegram and
// long-polls for messages, then streams the Genesis agent's reply back into the
// chat. Each Telegram thread maps 1:1 to a Genesis session (thread.id), so the
// agent keeps context per conversation; with GENESIS_HOST=vercel each runs in
// its own Firecracker microVM.
//
// Env:
//   TELEGRAM_BOT_TOKEN   (required) — from @BotFather
//   TELEGRAM_BOT_USERNAME (optional) — bot handle
//   GENESIS_URL          (optional) — defaults to the live Railway deploy
//   GENESIS_TOKEN        (optional) — bearer if the Genesis deploy is gated

import { createMemoryState } from "@chat-adapter/state-memory";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Chat, type Logger, type StateAdapter } from "chat";
import { parseAllowlist } from "./allowlist";
import { botStateFile, createFileState } from "./file-state";
import { handleAgentMessage, nativeCommandMenu } from "./handler";

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error("[genesis-bot] TELEGRAM_BOT_TOKEN is required (create a bot via @BotFather).");
  process.exit(1);
}
const userName = process.env.TELEGRAM_BOT_USERNAME ?? "genesis_bot";
const baseUrl = process.env.GENESIS_URL ?? "https://genesis-production-c94a.up.railway.app";
const token = process.env.GENESIS_TOKEN;

const logger: Logger = {
  debug: (m, meta) => console.debug(`[debug] ${m}`, meta ?? ""),
  info: (m, meta) => console.log(`[info] ${m}`, meta ?? ""),
  warn: (m, meta) => console.warn(`[warn] ${m}`, meta ?? ""),
  error: (m, meta) => console.error(`[error] ${m}`, meta ?? ""),
  child: () => logger,
};

const telegram = createTelegramAdapter({ botToken, mode: "polling", userName, logger });

// State backend (BRO-1492): GENESIS_BOT_STATE_DIR → restart-durable file state
// (subscriptions survive a bot restart, so ongoing DMs aren't dropped). Unset →
// in-memory (ephemeral; fine for throwaway runs). Redis stays the prod option.
const stateDir = process.env.GENESIS_BOT_STATE_DIR;
const state: StateAdapter = stateDir
  ? createFileState(botStateFile(stateDir))
  : createMemoryState();
if (stateDir) console.log(`[genesis-bot] durable subscription state: ${botStateFile(stateDir)}`);
const chat = new Chat({ userName, adapters: { telegram }, state, logger });

// Owner allowlist (BRO-1512): when set, only these threads are served. Required
// when the agent's workspace is a real dir (auto-allow agent = RCE-by-DM
// otherwise). Unset → allow-all (sandbox posture).
const allowlist = parseAllowlist(process.env.GENESIS_TELEGRAM_ALLOWED_USERS);
console.log(
  allowlist.open
    ? "[genesis-bot] allowlist OPEN — serving all threads (sandbox posture)"
    : "[genesis-bot] allowlist ENFORCED — only configured threads are served",
);

/** Drop a message from a non-allowlisted thread (logged, not replied to —
 *  silence avoids confirming the bot exists to unauthorized users). */
function gate(threadId: string): boolean {
  if (allowlist.allows(threadId)) return true;
  console.warn(`[genesis-bot] ignored message from non-allowlisted thread ${threadId}`);
  return false;
}

// DMs: `onDirectMessage` fires for EVERY direct message regardless of
// subscription state (BRO-1492). This is the robust fix for the restart
// black-hole — without it, a bot restart loses the in-memory subscription and a
// plain DM is neither a "new mention" (so onNewMention skips) nor "subscribed"
// (so onSubscribedMessage skips), and the message is silently dropped. With it,
// every DM is handled, so a restart never strands a conversation.
chat.onDirectMessage(async (thread, message) => {
  if (!gate(thread.id)) return;
  await handleAgentMessage(thread, message.text, { baseUrl, token });
});

// Groups: subscribe on first @-mention, then handle every follow-up. Group
// subscriptions survive a restart via the durable FileState (GENESIS_BOT_STATE_DIR).
chat.onNewMention(async (thread, message) => {
  if (!gate(thread.id)) return;
  await thread.subscribe();
  await handleAgentMessage(thread, message.text, { baseUrl, token });
});
chat.onSubscribedMessage(async (thread, message) => {
  if (!gate(thread.id)) return;
  await handleAgentMessage(thread, message.text, { baseUrl, token });
});

// Register the native Telegram `/` menu (control commands only — the full
// skill palette is discoverable via /commands; BRO-1493). Best-effort: a failed
// registration must never block the bot from polling.
async function registerTelegramCommands(): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: nativeCommandMenu() }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (body.ok) console.log(`[genesis-bot] registered ${nativeCommandMenu().length} / commands`);
    else console.warn(`[genesis-bot] setMyCommands failed: ${body.description ?? res.status}`);
  } catch (e) {
    console.warn("[genesis-bot] setMyCommands error (non-fatal)", e);
  }
}

console.log(`[genesis-bot] polling Telegram as @${userName} → Genesis at ${baseUrl}`);
await chat.initialize();
await registerTelegramCommands();

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
