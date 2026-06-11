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
import { Chat, type Logger } from "chat";
import { handleAgentMessage } from "./handler";

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
const chat = new Chat({ userName, adapters: { telegram }, state: createMemoryState(), logger });

// A Telegram DM routes every message as a mention (the bot is the only other
// participant), so this catches all incoming user text.
chat.onNewMention(async (thread, message) => {
  await handleAgentMessage(thread, message.text, { baseUrl, token });
});

console.log(`[genesis-bot] polling Telegram as @${userName} → Genesis at ${baseUrl}`);
await chat.initialize();

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
