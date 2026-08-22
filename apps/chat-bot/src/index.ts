// Genesis chat channels (Chat SDK / vercel/chat).
//
// Telegram runs in POLLING mode: the bot connects OUT and long-polls, so it
// needs no public URL. WhatsApp (Kapso) cannot — WhatsApp is webhook-only, so
// registering it also starts an HTTP listener. That asymmetry is the whole
// difference between the two channels here.
//
// Each thread maps 1:1 to a Genesis session (thread.id), so the agent keeps
// context per conversation.
//
// Env — Telegram:
//   TELEGRAM_BOT_TOKEN            (required) — from @BotFather
//   TELEGRAM_BOT_USERNAME         (optional) — bot handle
//   GENESIS_TELEGRAM_ALLOWED_USERS (required unless GENESIS_ALLOW_OPEN=1)
//
// Env — WhatsApp (all three required to register the channel at all):
//   KAPSO_API_KEY                 project API key. NOTE: this can send messages
//                                 from a real business number — a live
//                                 side-effect credential, not a read key.
//   KAPSO_PHONE_NUMBER_ID         the sending number
//   KAPSO_WEBHOOK_SECRET          verifies Kapso's X-Webhook-Signature
//   GENESIS_WHATSAPP_ALLOWED_USERS (required unless GENESIS_ALLOW_OPEN=1)
//   GENESIS_WHATSAPP_WORKSPACE_ID (recommended) — pin WhatsApp sessions to a
//                                 dedicated workspace. A phone number is
//                                 publicly messageable, so confining it to its
//                                 own workspace bounds what a mistaken
//                                 allowlist entry can reach.
//   GENESIS_BOT_WEBHOOK_PORT      listener port (default 8788)
//   GENESIS_BOT_WEBHOOK_PATH      route (default /webhooks/kapso)
//
// Env — shared:
//   GENESIS_URL, GENESIS_TOKEN, GENESIS_BOT_STATE_DIR, GENESIS_ALLOW_OPEN

import { createMemoryState } from "@chat-adapter/state-memory";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createKapsoAdapter } from "@kapso/chat-adapter";
import { Chat, type Logger, type StateAdapter } from "chat";
import { type ChannelConfig, principalOf, startupGateFor } from "./allowlist";
import { botStateFile, createFileState } from "./file-state";
import {
  type HandlerOptions,
  handleAgentMessage,
  nativeCommandMenu,
  workspaceIdFor,
} from "./handler";

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

// WhatsApp registers only when FULLY configured. A partial config (key but no
// webhook secret) would otherwise start an unauthenticated listener, so the
// all-or-nothing check is deliberate — see the startup gate below, which then
// requires an allowlist for whatever did register.
const kapsoApiKey = process.env.KAPSO_API_KEY;
const kapsoPhoneNumberId = process.env.KAPSO_PHONE_NUMBER_ID;
const kapsoWebhookSecret = process.env.KAPSO_WEBHOOK_SECRET;
const kapsoConfigured = Boolean(kapsoApiKey && kapsoPhoneNumberId && kapsoWebhookSecret);

const kapsoPartial =
  !kapsoConfigured && Boolean(kapsoApiKey || kapsoPhoneNumberId || kapsoWebhookSecret);
if (kapsoPartial) {
  console.error(
    "[genesis-bot] partial Kapso config — refusing to start. Set ALL of " +
      "KAPSO_API_KEY, KAPSO_PHONE_NUMBER_ID, KAPSO_WEBHOOK_SECRET, or none. " +
      "(Without the webhook secret, inbound deliveries cannot be verified.)",
  );
  process.exit(1);
}

// State backend (BRO-1492): GENESIS_BOT_STATE_DIR → restart-durable file state
// (subscriptions survive a bot restart, so ongoing DMs aren't dropped). Unset →
// in-memory (ephemeral; fine for throwaway runs). Redis stays the prod option.
const stateDir = process.env.GENESIS_BOT_STATE_DIR;
const state: StateAdapter = stateDir
  ? createFileState(botStateFile(stateDir))
  : createMemoryState();
if (stateDir) console.log(`[genesis-bot] durable subscription state: ${botStateFile(stateDir)}`);

const chat = kapsoConfigured
  ? new Chat({
      userName,
      adapters: {
        telegram,
        kapso: createKapsoAdapter({
          kapsoApiKey,
          phoneNumberId: kapsoPhoneNumberId,
          webhookSecret: kapsoWebhookSecret,
        }),
      },
      state,
      logger,
    })
  : new Chat({ userName, adapters: { telegram }, state, logger });

// Owner allowlist (BRO-1512/1534/2216): only configured principals are served,
// gated PER REGISTERED CHANNEL. Configuring Telegram does not vouch for
// WhatsApp — registering a channel and forgetting its allowlist is a refusal,
// because a WhatsApp number is publicly messageable by anyone who knows it.
const channels: ChannelConfig[] = [
  {
    channel: "telegram",
    raw: process.env.GENESIS_TELEGRAM_ALLOWED_USERS,
    envVar: "GENESIS_TELEGRAM_ALLOWED_USERS",
  },
];
if (kapsoConfigured) {
  channels.push({
    channel: "kapso",
    raw: process.env.GENESIS_WHATSAPP_ALLOWED_USERS,
    envVar: "GENESIS_WHATSAPP_ALLOWED_USERS",
  });
}

const gateDecision = startupGateFor(channels, process.env.GENESIS_ALLOW_OPEN === "1");
if (gateDecision.action === "refuse") {
  console.error(`[genesis-bot] ${gateDecision.reason}`);
  process.exit(1);
}
const allowlist = gateDecision.allowlist;
console.log(
  gateDecision.open
    ? "[genesis-bot] allowlist OPEN — serving ALL threads (GENESIS_ALLOW_OPEN=1, sandbox posture)"
    : "[genesis-bot] allowlist ENFORCED — only configured principals are served",
);

/** Drop a message from a non-allowlisted thread.
 *
 *  Still silent to the sender — replying would confirm the bot exists to an
 *  unauthorized user. But the LOG now says which refusal it was (BRO-2216):
 *  `not-listed` is the control working; `unresolvable` means it could not even
 *  parse the thread id, which is a misconfiguration wearing the same silence.
 *  Collapsing the two is what makes a broken gate look like a dead bot — and
 *  sends an operator to GENESIS_ALLOW_OPEN=1 to "fix" it. */
function gate(threadId: string): boolean {
  const decision = allowlist.decide(threadId);
  if (decision.allowed) return true;
  if (decision.reason === "unresolvable") {
    console.warn(
      `[genesis-bot] REFUSED ${threadId} — could not resolve a principal from this thread id. This is a CONFIG problem, not an unauthorized user. Do NOT set GENESIS_ALLOW_OPEN=1 to work around it.`,
    );
  } else {
    // Name the principal, not just the thread id. A Kapso thread id carries the
    // sender base64-encoded, so without this the operator must hand-decode it to
    // learn what to allowlist — friction that pushes toward GENESIS_ALLOW_OPEN=1.
    // Printing the exact string to add makes the safe path the easy one.
    const p = principalOf(threadId, "telegram");
    const hint = p ? `${p.channel}:${p.id}` : threadId;
    console.warn(
      `[genesis-bot] refused ${threadId} — principal not in the allowlist. To authorize this sender, add "${hint}".`,
    );
  }
  return false;
}

/** Per-channel handler options. WhatsApp is pinned to its own workspace when
 *  configured; Telegram keeps the engine default (unchanged behavior).
 *  The routing decision itself lives in `workspaceIdFor` so it can be tested. */
function optionsFor(threadId: string): HandlerOptions {
  const workspaceId = workspaceIdFor(threadId, process.env.GENESIS_WHATSAPP_WORKSPACE_ID);
  return workspaceId ? { baseUrl, token, workspaceId } : { baseUrl, token };
}

// DMs: `onDirectMessage` fires for EVERY direct message regardless of
// subscription state (BRO-1492). This is the robust fix for the restart
// black-hole — without it, a bot restart loses the in-memory subscription and a
// plain DM is neither a "new mention" (so onNewMention skips) nor "subscribed"
// (so onSubscribedMessage skips), and the message is silently dropped. With it,
// every DM is handled, so a restart never strands a conversation.
// WhatsApp threads are always DMs (the Kapso adapter reports isDM: true), so
// this is the only path WhatsApp traffic takes.
chat.onDirectMessage(async (thread, message) => {
  if (!gate(thread.id)) return;
  await handleAgentMessage(thread, message.text, optionsFor(thread.id));
});

// Groups: subscribe on first @-mention, then handle every follow-up. Group
// subscriptions survive a restart via the durable FileState (GENESIS_BOT_STATE_DIR).
chat.onNewMention(async (thread, message) => {
  if (!gate(thread.id)) return;
  await thread.subscribe();
  await handleAgentMessage(thread, message.text, optionsFor(thread.id));
});
chat.onSubscribedMessage(async (thread, message) => {
  if (!gate(thread.id)) return;
  await handleAgentMessage(thread, message.text, optionsFor(thread.id));
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

/** Kapso webhook listener. Only started when WhatsApp is registered, so the
 *  Telegram-only deployment keeps its "no inbound port" posture. Signature
 *  verification is the adapter's (KAPSO_WEBHOOK_SECRET); this only routes. */
function startWebhookServer(): void {
  const port = Number(process.env.GENESIS_BOT_WEBHOOK_PORT ?? 8788);
  const path = process.env.GENESIS_BOT_WEBHOOK_PATH ?? "/webhooks/kapso";
  // `chat` is a union of the two constructor shapes above, so `webhooks.kapso`
  // is not statically present on the Telegram-only arm. This branch only runs
  // under `kapsoConfigured`, where the adapter IS registered.
  const { kapso: kapsoWebhook } = (
    chat as unknown as { webhooks: { kapso?: (r: Request) => Promise<Response> } }
  ).webhooks;
  if (typeof kapsoWebhook !== "function") {
    console.error("[genesis-bot] kapso adapter registered but no webhook handler — not listening.");
    return;
  }

  Bun.serve({
    port,
    hostname: "127.0.0.1", // Funnel/proxy terminates TLS and forwards; never bind public directly
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return new Response("ok", { status: 200 });
      }
      if (url.pathname !== path) return new Response("not found", { status: 404 });
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      try {
        return await kapsoWebhook(req);
      } catch (e) {
        // Log our side; return an opaque 500 so a malformed/forged delivery
        // learns nothing about why it was rejected.
        console.error("[genesis-bot] kapso webhook error", e);
        return new Response("error", { status: 500 });
      }
    },
  });
  console.log(`[genesis-bot] kapso webhook listening on 127.0.0.1:${port}${path}`);
}

const active = kapsoConfigured ? "Telegram (polling) + WhatsApp (webhook)" : "Telegram (polling)";
console.log(`[genesis-bot] ${active} as @${userName} → Genesis at ${baseUrl}`);
if (kapsoConfigured && process.env.GENESIS_WHATSAPP_WORKSPACE_ID) {
  console.log(
    `[genesis-bot] WhatsApp sessions pinned to workspace ${process.env.GENESIS_WHATSAPP_WORKSPACE_ID}`,
  );
} else if (kapsoConfigured) {
  console.warn(
    "[genesis-bot] GENESIS_WHATSAPP_WORKSPACE_ID unset — WhatsApp sessions will use the " +
      "engine default workspace. A public number should be pinned to a dedicated one.",
  );
}

await chat.initialize();
await registerTelegramCommands();
if (kapsoConfigured) startWebhookServer();

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
