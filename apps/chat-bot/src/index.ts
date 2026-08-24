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
//   GENESIS_WHATSAPP_WORKSPACE_PREFIX (required) — one workspace PER SENDER:
//                                 dedicated workspace. A phone number is
//                                 publicly messageable, so confining it to its
//                                 own workspace bounds what a mistaken
//                                 allowlist entry can reach.
//   GENESIS_BOT_WEBHOOK_PORT      listener port (default 8788)
//   GENESIS_BOT_WEBHOOK_PATH      route (default /webhooks/kapso)
//
// Env — shared:
//   GENESIS_URL, GENESIS_TOKEN, GENESIS_BOT_STATE_DIR, GENESIS_ALLOW_OPEN

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createKapsoAdapter } from "@kapso/chat-adapter";
import { WhatsAppClient } from "@kapso/whatsapp-cloud-api";
import { Chat, type Logger, type StateAdapter } from "chat";
import { type ChannelConfig, principalOf, startupGateFor } from "./allowlist";
import { botStateFile, createFileState } from "./file-state";
import { genesisStream } from "./genesis";
import {
  CHUNK_TARGET,
  type HandlerOptions,
  TURN_STATUS_EMOJI,
  type TurnSignals,
  chunkForWhatsapp,
  handleAgentMessage,
  nativeCommandMenu,
  parseCommand,
  tenantWorkspaceId,
  unregisteredTenants,
  workspaceDecisionFor,
} from "./handler";
import {
  applyOperatorCommand,
  isOperator,
  isOperatorToken,
  parseOperatorCommand,
} from "./operator";
import { DEFAULT_STALL_MS, withStallTimeout } from "./stall-timeout";
import { TenantStore } from "./tenant-store";
import { admit, pruneTimestamps, rateLimit } from "./tenants";
import { drainOnce } from "./voice-delivery";
import { textToDispatch } from "./voice-note";
import { webhookPort } from "./webhook-port";
import { FENCE_OVERHEAD, balanceFences, markdownToWhatsApp } from "./whatsapp-format";

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

// One Genesis workspace per WhatsApp SENDER (BRO-2224): `<prefix><waId>`, e.g.
// ws-wa-573017758620 -> /home/agent/orchestrator-workspaces/573017758620. The
// prefix value carries no security weight (the startup check verifies each
// derived id is really registered), so a default is safe; what matters is that
// ONE value feeds the banner, the dispatch path and the check.
const whatsappWorkspacePrefix = process.env.GENESIS_WHATSAPP_WORKSPACE_PREFIX?.trim() || "ws-wa-";

// Tenant registry (BRO-2230). Configured -> IT is the gate for WhatsApp and the
// env allowlist is ignored for that channel; two gates on one channel is a
// drift hazard, so exactly one is in force and the log says which.
const tenantsDir = process.env.GENESIS_WHATSAPP_TENANTS_DIR?.trim();
const tenantStore = tenantsDir ? new TenantStore(tenantsDir) : undefined;

/** Per-tenant sliding-window limiter. IN MEMORY, so it resets on restart — a
 *  restart is the one way to get a free burst. Acceptable while the bot is a
 *  single process; a shared store is needed before it is not. */
const RATE_WINDOW_MS = Number(process.env.GENESIS_WHATSAPP_RATE_WINDOW_MS ?? 60_000);
const RATE_MAX = Number(process.env.GENESIS_WHATSAPP_RATE_MAX ?? 6);
const rateHits = new Map<string, number[]>();

/** Admit an inbound thread. Telegram keeps the env allowlist unchanged; a
 *  WhatsApp thread goes through the registry when one is configured.
 *
 *  Returns false for every non-served case, having already done whatever that
 *  case requires (record the request, send the single acknowledgement, or stay
 *  silent). The caller only needs to know whether to dispatch. */
async function admitThread(thread: {
  id: string;
  post: (c: string) => Promise<unknown>;
}): Promise<boolean> {
  if (!tenantStore || !thread.id.startsWith("kapso:")) return gate(thread.id);

  const now = new Date().toISOString();
  let decision: ReturnType<typeof admit>;
  try {
    decision = admit(thread.id, (id) => tenantStore.get(id), now);
  } catch (e) {
    // An unreadable record must NOT fall through to "unknown sender" — that
    // would re-acknowledge an approved tenant as a new requester. Refuse.
    console.error(
      `[genesis-bot] tenant lookup failed for ${thread.id}: ${e instanceof Error ? e.message : e}`,
    );
    return false;
  }

  if (decision.kind === "ignore") {
    console.warn(`[genesis-bot] not serving ${thread.id} — ${decision.reason}`);
    return false;
  }

  if (decision.kind === "acknowledge") {
    tenantStore.put(decision.tenant);
    console.log(
      `[genesis-bot] new access request from ${decision.tenant.id} — recorded as pending`,
    );
    await thread
      .post(
        "Thanks for reaching out. This assistant is invite-only, so your request has been passed to the operator. You'll hear back here if it's approved.",
      )
      .catch((e) => console.error(`[genesis-bot] could not acknowledge request: ${e}`));
    return false;
  }

  // serve — rate limit before dispatching, since a turn is the expensive part.
  const nowMs = Date.now();
  const hits = pruneTimestamps(rateHits.get(decision.tenant.id) ?? [], nowMs, RATE_WINDOW_MS);
  const limit = rateLimit(hits, nowMs, RATE_WINDOW_MS, RATE_MAX);
  if (!limit.allowed) {
    console.warn(
      `[genesis-bot] rate-limited ${decision.tenant.id} — retry in ${Math.ceil(limit.retryAfterMs / 1000)}s`,
    );
    rateHits.set(decision.tenant.id, hits);
    return false;
  }
  hits.push(nowMs);
  rateHits.set(decision.tenant.id, hits);
  // Stamp ONLY lastSeenAt. `put(decision.tenant)` wrote the whole record from a
  // snapshot read earlier in this request, so an operator approval arriving in
  // between was reverted to `pending` by the very next message.
  tenantStore.touchLastSeen(decision.tenant.id, new Date().toISOString());
  return true;
}

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

// Hoisted rather than inlined into the Chat config because the turn-status
// reactions need the adapter directly: Chat SDK's inbound `Message` carries an
// id but no reaction methods (those live on `SentMessage`, i.e. messages WE
// sent), while `Adapter.addReaction(threadId, messageId, emoji)` can mark any
// message — including the user's own, which is the one we want.
const kapsoAdapter = kapsoConfigured
  ? createKapsoAdapter({
      kapsoApiKey,
      phoneNumberId: kapsoPhoneNumberId,
      webhookSecret: kapsoWebhookSecret,
    })
  : undefined;

const chat = kapsoAdapter
  ? new Chat({ userName, adapters: { telegram, kapso: kapsoAdapter }, state, logger })
  : new Chat({ userName, adapters: { telegram }, state, logger });

/** Turn-status reactions for a WhatsApp message, or undefined elsewhere.
 *
 *  WhatsApp-only on purpose. Telegram can EDIT a message, so it already shows
 *  progress by streaming the reply in place; adding reactions there would be a
 *  second, redundant status channel. This exists because WhatsApp has no edit
 *  and a reaction is its only mutable surface. */
function turnSignalsFor(threadId: string, messageId: string): TurnSignals | undefined {
  if (!kapsoAdapter || !threadId.startsWith("kapso:") || !messageId) return undefined;
  return {
    async setStatus(status) {
      await kapsoAdapter.addReaction(threadId, messageId, TURN_STATUS_EMOJI[status]);
    },
  };
}

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
 *  The routing decision itself lives in `workspaceDecisionFor` so it can be tested.
 *
 *  Returns undefined when the turn MUST NOT run: a WhatsApp thread whose tenant
 *  workspace could not be resolved. Dropping the turn is the only safe move —
 *  dispatching without a workspaceId inherits the engine default, which is the
 *  broadest workspace on the box, so "confinement unavailable" would silently
 *  become "maximum reach" for a public channel. */
function dispatchOptions(threadId: string): HandlerOptions | undefined {
  const decision = workspaceDecisionFor(threadId, whatsappWorkspacePrefix);
  if (decision.kind === "refuse") {
    console.error(
      `[genesis-bot] refusing to serve ${threadId}: ${decision.reason}. Not dispatching — an unconfined turn on a public channel would run in the engine default workspace.`,
    );
    return undefined;
  }
  // WhatsApp cannot edit sent messages, so it cannot render a streamed reply
  // (Chat SDK streams via post-then-edit). Buffer it instead.
  const streaming = !threadId.startsWith("kapso:");
  return decision.kind === "pin"
    ? { baseUrl, token, workspaceId: decision.workspaceId, streaming }
    : { baseUrl, token, streaming };
}

// DMs: `onDirectMessage` fires for EVERY direct message regardless of
// subscription state (BRO-1492). This is the robust fix for the restart
// black-hole — without it, a bot restart loses the in-memory subscription and a
// plain DM is neither a "new mention" (so onNewMention skips) nor "subscribed"
// (so onSubscribedMessage skips), and the message is silently dropped. With it,
// every DM is handled, so a restart never strands a conversation.
// WhatsApp threads are always DMs (the Kapso adapter reports isDM: true), so
// this is the only path WhatsApp traffic takes.
/** The principal allowed to change the registry from the channel itself.
 *  Digits only. UNSET means nobody -- see `isOperator`, which fails closed. */
const operatorPrincipal = process.env.GENESIS_WHATSAPP_OPERATOR?.trim();

/** Handle an operator command. Returns true when it was one (and was handled).
 *
 *  Runs AFTER admit, so an unadmitted sender never learns this surface exists,
 *  and the token check runs BEFORE the operator check so that a tenant typing
 *  `/allow` gets the ordinary unknown-command path -- forwarded to the agent --
 *  rather than a refusal that confirms the command is real. */
async function maybeHandleOperator(
  thread: { id: string; post: (t: string) => Promise<unknown> },
  text: string,
): Promise<boolean> {
  const parsed = parseCommand(text);
  if (parsed === undefined || !isOperatorToken(parsed.token)) return false;
  if (!isOperator(thread.id, operatorPrincipal)) return false;
  if (!tenantStore) {
    await thread.post("No tenant registry is configured on this deployment.");
    return true;
  }
  const cmd = parseOperatorCommand(parsed.token, parsed.args);
  if (cmd === undefined) return false;
  if ("error" in cmd) {
    await thread.post(cmd.error);
    return true;
  }
  const result = applyOperatorCommand(cmd, tenantStore, new Date().toISOString());
  console.log(
    `[genesis-bot] operator ${parsed.token} -> ${result.needsApply ? "registry changed" : "no change"}`,
  );
  await thread.post(result.reply);
  return true;
}

chat.onDirectMessage(async (thread, message) => {
  // OPERATOR COMMANDS RUN BEFORE ADMISSION, and the order is load-bearing.
  //
  // Admission-first deadlocked the registry at bootstrap: with no tenants yet, the
  // operator's own first message creates a PENDING record, admitThread returns
  // false, and every later message is stopped before maybeHandleOperator ever runs
  // -- so the one person who can approve tenants could never issue /tapprove. The
  // registry could only ever be seeded out-of-band.
  //
  // Safe because maybeHandleOperator authenticates on its own and does not lean on
  // admission: it returns false unless the text parses as an operator command AND
  // `isOperator(thread.id, operatorPrincipal)` matches. A non-operator sending
  // "/tapprove" falls straight through to admitThread exactly as before, and so
  // does the operator sending ordinary text.
  //
  // WhatsApp threads are always DMs, and `isOperator` only resolves kapso thread
  // ids, so this is the only path where it can ever match.
  if (await maybeHandleOperator(thread, message.text)) return;
  if (!(await admitThread(thread))) return;
  const opts = dispatchOptions(thread.id);
  if (!opts) return;
  const text = await textToDispatch(thread, message);
  if (!text) return;
  await handleAgentMessage(thread, text, opts, turnSignalsFor(thread.id, message.id));
});

// Groups: subscribe on first @-mention, then handle every follow-up. Group
// subscriptions survive a restart via the durable FileState (GENESIS_BOT_STATE_DIR).
chat.onNewMention(async (thread, message) => {
  if (!(await admitThread(thread))) return;
  await thread.subscribe();
  const opts = dispatchOptions(thread.id);
  if (!opts) return;
  const text = await textToDispatch(thread, message);
  if (!text) return;
  await handleAgentMessage(thread, text, opts, turnSignalsFor(thread.id, message.id));
});
chat.onSubscribedMessage(async (thread, message) => {
  if (!(await admitThread(thread))) return;
  const opts = dispatchOptions(thread.id);
  if (!opts) return;
  const text = await textToDispatch(thread, message);
  if (!text) return;
  await handleAgentMessage(thread, text, opts, turnSignalsFor(thread.id, message.id));
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
  const port = webhookPort(process.env.GENESIS_BOT_WEBHOOK_PORT);
  if (port === undefined) {
    // Loud and NOT listening beats quietly listening on a port nobody forwards to.
    // Telegram keeps serving, matching the missing-handler branch below.
    console.error(
      `[genesis-bot] GENESIS_BOT_WEBHOOK_PORT=${JSON.stringify(process.env.GENESIS_BOT_WEBHOOK_PORT)} is not a port (want an integer 1-65535). NOT listening — every inbound WhatsApp message would be refused at the proxy. Unset it to use the default 8788.`,
    );
    return;
  }
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

  const server = Bun.serve({
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
  // Report the port the SERVER bound, never the one we asked for. The old line
  // printed the request, so a bad value announced a listener that was not there.
  console.log(`[genesis-bot] kapso webhook listening on 127.0.0.1:${server.port}${path}`);
}

const active = kapsoConfigured ? "Telegram (polling) + WhatsApp (webhook)" : "Telegram (polling)";
console.log(`[genesis-bot] ${active} as @${userName} → Genesis at ${baseUrl}`);
// The single-workspace var is GONE (BRO-2224). Refuse rather than ignore it: a
// stale env would otherwise keep the old NAME while the code gives it a new
// MEANING, and the operator would read "pinned" in the log while every sender
// shared one directory — exactly the collision this change removes.
if (process.env.GENESIS_WHATSAPP_WORKSPACE_ID) {
  console.error(
    "[genesis-bot] GENESIS_WHATSAPP_WORKSPACE_ID is no longer supported — it pinned EVERY " +
      "sender to one shared workspace. Replace it with GENESIS_WHATSAPP_WORKSPACE_PREFIX " +
      '(e.g. "ws-wa-"), which derives one workspace per sender, and provision a tenant ' +
      "directory for each allowlisted principal.",
  );
  process.exit(1);
}
if (kapsoConfigured) {
  console.log(
    `[genesis-bot] WhatsApp sessions confined per sender: ${whatsappWorkspacePrefix}<waId>`,
  );
}

/** Refuse to serve WhatsApp unless EVERY allowlisted sender's tenant workspace
 *  really exists in the engine (BRO-2224).
 *
 *  The engine binds an unknown workspaceId to the DEFAULT workspace instead of
 *  refusing, so an unprovisioned tenant does not fail — it silently runs in the
 *  broadest workspace on the box while the startup log still says "confined".
 *  Verified on the VPS: "ws-doesnotexist" ran the agent in /home/agent.
 *
 *  Checked per principal, not just "at least one exists": with N senders and a
 *  provisioning script that half-ran, an any-of check passes while the
 *  unprovisioned senders all land in the default workspace TOGETHER — the
 *  collision this change exists to remove, plus maximum reach.
 *
 *  Retries briefly because genesis-api may still be coming up (systemd orders
 *  us After= it, but ordering is not readiness). Exhausted → exit(1); the unit
 *  is Restart=on-failure, so this recovers on its own once the API answers.
 *  Never degrades to "assume it is fine". */
async function assertTenantWorkspacesRegistered(): Promise<void> {
  // An OPEN allowlist authorizes senders we cannot name, so we cannot
  // pre-provision their workspaces, so every unknown sender would fall to the
  // engine default. Per-tenant confinement and an open channel are mutually
  // exclusive by construction — say so rather than serving unconfined.
  // A registry makes GENESIS_ALLOW_OPEN moot for WhatsApp: unknown senders are
  // recorded as requests rather than served, which is the controlled version of
  // "open" and does not require pre-provisioning the world.
  if (!tenantStore && allowlist.open) {
    console.error(
      "[genesis-bot] GENESIS_ALLOW_OPEN=1 cannot be combined with per-sender WhatsApp " +
        "workspaces: an open channel serves senders that have no provisioned tenant " +
        "directory, and each would run in the engine default workspace. Set " +
        "GENESIS_WHATSAPP_ALLOWED_USERS instead.",
    );
    process.exit(1);
  }

  // With a registry configured it is the source of truth; the env allowlist is
  // not consulted for WhatsApp at all. Verifying against the wrong source would
  // check workspaces nobody is served from while the real tenants go unchecked.
  const principals = tenantStore
    ? tenantStore.active().map((t) => ({ channel: "kapso" as const, id: t.id }))
    : allowlist.principals.filter((p) => p.channel === "kapso");
  const tenants = principals.map((p) => ({
    principal: p,
    workspaceId: tenantWorkspaceId(p, whatsappWorkspacePrefix),
  }));

  if (tenants.length === 0) {
    // With a registry this is NORMAL on day one: nobody is approved yet, and
    // the bot must still run so it can RECEIVE the first request. Without one,
    // it means a misconfigured allowlist and there is nothing to serve.
    if (tenantStore) {
      console.log(
        "[genesis-bot] tenant registry empty — serving requests only until someone is approved",
      );
      return;
    }
    console.error(
      "[genesis-bot] WhatsApp is registered but the allowlist names no WhatsApp principal. " +
        "Refusing to serve: there is no tenant workspace for any sender to run in.",
    );
    process.exit(1);
  }

  const url = `${baseUrl.replace(/\/$/, "")}/workspaces`;
  let lastErr = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
      } else {
        const payload = await res.json();
        const missingIds = unregisteredTenants(
          payload,
          tenants.map((t) => t.workspaceId),
        );
        const missing = tenants.filter((t) => missingIds.includes(t.workspaceId));
        if (missing.length === 0) {
          console.log(
            `[genesis-bot] verified ${tenants.length} WhatsApp tenant workspace(s): ${tenants.map((t) => t.workspaceId).join(", ")}`,
          );
          return;
        }
        console.error(
          `[genesis-bot] ${missing.length} of ${tenants.length} WhatsApp tenant workspace(s) are NOT registered/available: ${missing.map((t) => `${t.workspaceId} (sender ${t.principal.id})`).join(", ")}. Refusing to serve WhatsApp: the engine would silently bind the DEFAULT workspace for those senders, giving a public channel far more reach than intended. Run the tenant provisioning script and restart.`,
        );
        process.exit(1);
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    if (attempt < 5) await new Promise((r) => setTimeout(r, 2000));
  }
  console.error(
    `[genesis-bot] could not verify WhatsApp tenant workspaces against ${url} (${lastErr}). Refusing to serve WhatsApp rather than assume the confinement holds.`,
  );
  process.exit(1);
}

if (kapsoConfigured) await assertTenantWorkspacesRegistered();

await chat.initialize();
await registerTelegramCommands();
if (kapsoConfigured) startWebhookServer();
/** Drain the voice queue: run each recorded request as a turn, answer over
 *  WhatsApp (BRO-2284, BRO-2228 item 4).
 *
 *  BEST-EFFORT ON PURPOSE. A phone call does not open WhatsApp's 24-hour service
 *  window, so a caller who has not messaged us recently CANNOT be delivered to —
 *  and that is only discoverable when the send fails. /voice/request therefore
 *  still promises nothing. This turns a recorded request into an answer when it
 *  can, and says why in the log when it cannot. */
function startVoiceDelivery(): void {
  const queueDir =
    process.env.GENESIS_VOICE_QUEUE_DIR?.trim() ||
    join(
      process.env.GENESIS_DATA_DIR?.trim() || join(homedir() || tmpdir(), ".genesis", "data"),
      "voice",
    );
  const phoneNumberId = kapsoPhoneNumberId;
  if (!phoneNumberId) return;
  // baseUrl is REQUIRED to route through Kapso. The client defaults to
  // https://graph.facebook.com — Meta direct — which authenticates with an
  // accessToken we do not have, so a kapsoApiKey against that default fails with
  // a bare "Authentication Error". Dogfooding hit exactly that: the turn ran, the
  // answer came back, and the send was rejected. Same constant the Kapso chat
  // adapter uses (DEFAULT_KAPSO_BASE_URL).
  const wa = new WhatsAppClient({
    kapsoApiKey,
    baseUrl: process.env.KAPSO_BASE_URL?.trim() || "https://api.kapso.ai/meta/whatsapp",
  });
  const raw = Number(process.env.GENESIS_VOICE_POLL_MS);
  const intervalMs = Number.isFinite(raw) && raw >= 1000 ? raw : 15_000;
  const rawStall = Number(process.env.GENESIS_VOICE_STALL_MS);
  const voiceStallMs = Number.isFinite(rawStall) && rawStall >= 1000 ? rawStall : DEFAULT_STALL_MS;
  const rawSend = Number(process.env.GENESIS_VOICE_SEND_MS);
  const voiceSendMs = Number.isFinite(rawSend) && rawSend >= 1000 ? rawSend : 60_000;

  let running = false;
  const tick = async () => {
    // NEVER overlap. A drain runs real agent turns and can take minutes; a
    // second pass would re-read tickets the first has not recorded yet and
    // answer them twice.
    if (running) return;
    running = true;
    try {
      const r = await drainOnce({
        queueDir,
        log: (m) => console.log(`[genesis-bot] ${m}`),
        // The caller's OWN tenant workspace — a voice request is confined
        // exactly as that number's WhatsApp turn is.
        workspaceFor: (deliverTo) =>
          tenantWorkspaceId({ channel: "kapso", id: deliverTo }, whatsappWorkspacePrefix),
        dispatch: async (ticket, workspaceId) => {
          // BOUNDED, and found by dogfooding: the first live drain sat on a turn
          // for nine minutes with no bound at all, and because a pass never
          // overlaps itself, one slow request stalls every later ticket behind it
          // indefinitely. Same shape the WhatsApp handler uses.
          const abort = new AbortController();
          let lastActivity = Date.now();
          let out = "";
          const stream = withStallTimeout(
            genesisStream({
              baseUrl,
              // A fresh session per ticket: a voice request is a one-shot ask, and
              // sharing a thread would bleed context between unrelated calls.
              threadId: `voice:${ticket.id}`,
              text: ticket.request,
              token,
              workspaceId,
              signal: abort.signal,
              onActivity: () => {
                lastActivity = Date.now();
              },
            }),
            voiceStallMs,
            {
              // Aborting the fetch is what actually closes the socket; returning
              // the generator alone leaves a hung request in flight.
              onStall: () => abort.abort(),
              // Measured on ACTIVITY, not yields. genesisStream emits only text,
              // so a turn inside a long tool call yields nothing while being
              // perfectly healthy — a yield-based bound would kill it.
              idleMs: () => Date.now() - lastActivity,
            },
          );
          for await (const chunk of stream) out += chunk;
          return out;
        },
        send: async (to, text) => {
          // BOUNDED for the same reason the dispatch is, at the OTHER call site —
          // which is where this was missed. A Kapso send that accepts the
          // connection and never answers leaves `running` true forever, and every
          // later ticket is starved in silence. (P20 round 1.)
          // Chunked exactly as the WhatsApp handler does: a message over the
          // transport cap is REJECTED, and the answer then simply never arrives.
          const target = CHUNK_TARGET - FENCE_OVERHEAD;
          const chunks = balanceFences(chunkForWhatsapp(markdownToWhatsApp(text), target));
          for (const body of chunks.length ? chunks : [text]) {
            const bail = AbortSignal.timeout(voiceSendMs);
            await Promise.race([
              wa.messages.sendText({ phoneNumberId, to, body }),
              new Promise((_r, reject) => {
                bail.addEventListener("abort", () =>
                  reject(new Error(`whatsapp send exceeded ${voiceSendMs}ms`)),
                );
              }),
            ]);
          }
        },
      });
      if (r.attempted > 0 || r.skippedLines > 0) {
        const bad = r.skippedLines ? `, ${r.skippedLines} unparseable line(s)` : "";
        console.log(
          `[genesis-bot] voice drain: ${r.delivered} delivered, ${r.failed} failed, ${r.attempted} attempted of ${r.scanned} scanned${bad}`,
        );
      }
    } catch (e) {
      console.error(`[genesis-bot] voice drain failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      running = false;
    }
  };
  setInterval(tick, intervalMs).unref?.();
  void tick();
  console.log(`[genesis-bot] voice delivery → draining ${queueDir} every ${intervalMs}ms`);
}

if (kapsoConfigured) startVoiceDelivery();

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
