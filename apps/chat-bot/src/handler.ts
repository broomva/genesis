// The channel handler: a chat message → Genesis agent reply, streamed back into
// the thread. Decoupled from the full Chat SDK `Thread` via a minimal interface
// so it is unit-testable with a mock thread.
//
// Control commands (BRO-1493): a leading-slash control command (/new, /stop,
// /status, /commands, /help) is handled HERE — mapped to the Genesis /control
// surface or a local reply — and never forwarded to the agent. Telegram delivers
// commands as normal messages (no SlashCommandEvent), so routing lives in the
// one handler every message flows through. Skill commands (/autonomous, …) are
// NOT control commands, so they fall through and run in the session as a turn.

import { principalOf, tenantWorkspaceId } from "./allowlist";
import {
  CONTROL_COMMANDS,
  controlAction,
  enumerateSessionCommands,
  renderCommandList,
  renderHelp,
} from "./commands";
import { genesisStream } from "./genesis";

/** The slice of Chat SDK's `Thread` this handler needs. */
export interface PostableThread {
  /** Stable conversation id → Genesis session (continuity). */
  readonly id: string;
  /** Post a string or stream an AsyncIterable<string> (post+edit on Telegram). */
  post(content: string | AsyncIterable<string>): Promise<unknown>;
  /** Optional typing indicator. */
  startTyping?(): Promise<unknown>;
}

export interface HandlerOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
  /** Skills dirs for /commands enumeration (default: the user skills dir). */
  skillsDirs?: string[];
  /** Pin this channel's sessions to a Genesis workspace (sticky at create).
   *  Set per channel, so a public channel can be confined to a dedicated
   *  workspace while another keeps the engine default. */
  workspaceId?: string;
  /** Whether this channel can render a streamed reply.
   *
   *  Chat SDK streams by posting a message and then EDITING it as tokens
   *  arrive. Telegram supports edits; WhatsApp does not — the Kapso adapter
   *  throws `NotImplementedError: WhatsApp Cloud API does not support editing
   *  sent messages` from `editMessage`, which aborts the whole turn AFTER the
   *  agent has already done the work. So a channel without edits gets the reply
   *  buffered and posted once (chunked to the text cap).
   *
   *  Defaults to true — Telegram's behavior is unchanged. */
  streaming?: boolean;
  /** Chunk size for the buffered path. Defaults to CHUNK_TARGET; clamped to
   *  WHATSAPP_TEXT_LIMIT by chunkForWhatsapp so a misconfiguration degrades to
   *  "less readable" rather than "rejected by the transport". */
  chunkTarget?: number;
}

/** WhatsApp's text body cap — a hard protocol limit. A body above it is
 *  REJECTED, so every chunk must stay under it regardless of what the
 *  readability target below is set to. */
export const WHATSAPP_TEXT_LIMIT = 4096;

/** Default chunk size — sized to a PHONE SCREEN, not to the API cap.
 *
 *  This was 3900, which is what the transport accepts, not what a person can
 *  read: ~600 words arriving as one balloon reads as a document dump rather
 *  than a reply. The cap still governs what is *possible* (a chunk above
 *  WHATSAPP_TEXT_LIMIT is rejected outright); this governs what is
 *  *comfortable*. chunkForWhatsapp already prefers paragraph → line → space
 *  boundaries, so a smaller target mostly means breaking at paragraphs that
 *  were already there. */
export const CHUNK_TARGET = 1000;

/** Split a reply into WhatsApp-sized pieces, preferring paragraph then line
 *  breaks so chunks land on natural boundaries instead of mid-word.
 *
 *  Returns [] for empty input — the caller must not post an empty message
 *  (WhatsApp rejects it, and it would read as the agent replying with nothing). */
export function chunkForWhatsapp(text: string, limit: number = CHUNK_TARGET): string[] {
  const body = text.trim();
  if (!body) return [];
  // Clamp to the transport cap. The target is a READABILITY preference and is
  // configurable; the cap is a hard protocol limit. A caller that raises the
  // target above it would otherwise emit chunks WhatsApp rejects outright —
  // which surfaces as the reply silently not arriving, the exact failure mode
  // this channel is least able to diagnose. A non-positive limit would loop
  // forever, so it falls back to the default rather than hanging the turn.
  //
  //  `Math.floor` is load-bearing, not tidiness: a FRACTIONAL limit below 1
  //  (0.5) passes a `> 0` check, and then `slice(0, 0.5)` consumes zero
  //  characters, so `rest` never shrinks and the loop spins forever holding the
  //  event loop. Flooring to a minimum of 1 makes every accepted limit one that
  //  actually advances. (P20 round 1, MAJOR.)
  const requested = Math.floor(limit);
  const cap = requested > 0 ? Math.min(requested, WHATSAPP_TEXT_LIMIT) : CHUNK_TARGET;
  if (body.length <= cap) return [body];

  const out: string[] = [];
  let rest = body;
  while (rest.length > cap) {
    const window = rest.slice(0, cap);
    // Prefer a paragraph break, then a line break, then a space. `+ 1` keeps
    // the break character with the chunk being emitted.
    let cut = window.lastIndexOf("\n\n");
    if (cut < cap * 0.5) cut = window.lastIndexOf("\n");
    if (cut < cap * 0.5) cut = window.lastIndexOf(" ");
    if (cut < cap * 0.5) cut = cap; // no good boundary — hard split
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter((c) => c.length > 0);
}

/** Drain an async text stream into one string. */
export async function drainStream(stream: AsyncIterable<string>): Promise<string> {
  let acc = "";
  for await (const piece of stream) acc += piece;
  return acc;
}

/** How often to re-arm the typing indicator, in ms.
 *
 *  WhatsApp dismisses a typing indicator after ~25 SECONDS or on our first
 *  send, whichever comes first (Kapso, /docs/whatsapp/send-messages/mark-read).
 *  A Genesis turn is 9s for a trivial command and 30s-to-minutes for real work,
 *  so a SINGLE startTyping() — which is what this handler used to do — shows
 *  typing for 25s and then nothing. Silence after a promise of activity reads
 *  worse than silence alone: it looks like the bot died mid-thought.
 *
 *  20s re-arms inside the window with margin for a slow round trip. */
export const TYPING_REARM_MS = 20_000;

/** Hard ceiling on how long one turn may keep re-arming the indicator.
 *
 *  THE FEEDBACK LAYER SHARES A BUDGET WITH THE REPLY. Kapso allows 100
 *  requests/minute on the free plan (500 on Pro), counted per API key across
 *  the WHOLE project in a fixed window — and every re-arm is `markRead`, i.e. a
 *  request. Unbounded, a single 30-minute turn spends ~90 requests on saying
 *  "still working", and a handful of concurrent tenants could then exhaust the
 *  window so that the actual REPLIES are the calls that get 429'd. Feedback
 *  starving the product it is reporting on is strictly worse than no feedback.
 *
 *  Five minutes bounds one turn to ~15 re-arms. Past it the indicator lapses
 *  and the turn runs on silently, which is the pre-existing behaviour rather
 *  than a new failure. (P20 round 1, BLOCKER.) */
export const TYPING_MAX_MS = 5 * 60_000;

/** Keeps the channel's typing indicator alive for the duration of a turn.
 *
 *  Returns a stop function; calling it is mandatory (use try/finally) or the
 *  interval outlives the turn and keeps re-arming an indicator for a
 *  conversation that has already been answered.
 *
 *  Fires once immediately so the acknowledgment is instant rather than
 *  `rearmMs` late — the first 20 seconds are exactly when the user is deciding
 *  whether anything happened. Every call is best-effort: a channel with no
 *  typing support (or a transient API failure) must never fail the turn, since
 *  the indicator is a courtesy and the reply is the product.
 *
 *  Two guards beyond the interval, both from P20 round 1:
 *
 *  - `stopped` is checked INSIDE the async continuation, not just around the
 *    timer. `clearInterval` cannot cancel a call already in flight, so a slow
 *    `markRead` issued just before stop() would land AFTER the reply and show
 *    "typing" on an answered conversation. The flag makes a late arrival inert.
 *  - `inFlight` prevents overlap. If a round trip takes longer than `rearmMs`
 *    the naive version issues a second request on top of the first, and the
 *    slower the API is the more requests it gets — the exact inversion you want
 *    under pressure. */
export function keepTyping(
  thread: PostableThread,
  rearmMs: number = TYPING_REARM_MS,
  maxMs: number = TYPING_MAX_MS,
): () => void {
  if (!thread.startTyping) return () => {};
  let stopped = false;
  let inFlight = false;
  const deadline = Date.now() + maxMs;

  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };

  const fire = () => {
    if (stopped || inFlight) return;
    if (Date.now() >= deadline) {
      stop();
      return;
    }
    inFlight = true;
    void thread
      .startTyping?.()
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  };

  fire();
  const timer = setInterval(fire, rearmMs);
  // Never let a courtesy indicator hold the process open at shutdown.
  (timer as unknown as { unref?: () => void }).unref?.();
  return stop;
}

/** Lifecycle of one turn, as shown on the user's own inbound message. */
export type TurnStatus = "working" | "done" | "failed";

/** WhatsApp has no message edit, so a reply cannot be revised in place. A
 *  REACTION is the one primitive that changes an already-delivered message's
 *  appearance: sending a new emoji to the same message replaces this sender's
 *  previous one, and sending none removes it (verified in
 *  `@kapso/chat-adapter` 0.1.1 `dist`, whose `removeReaction` posts a reaction
 *  payload with the emoji field omitted — the docs state neither).
 *
 *  So the user's own question becomes the progress indicator for the turn it
 *  started, which is the only mutable surface this channel has. */
export const TURN_STATUS_EMOJI: Record<TurnStatus, string> = {
  working: "👀",
  done: "✅",
  failed: "⚠️",
};

/** Per-message side channel for turn status. Separate from PostableThread
 *  because it is scoped to ONE inbound message, not to the conversation:
 *  reacting to the wrong message is worse than not reacting at all. */
export interface TurnSignals {
  /** Replace the status marker on the message that started this turn. */
  setStatus?(status: TurnStatus): Promise<void>;
}

/** Meta's error code for "more than 24h since the customer last replied".
 *
 *  Verified against the SHIPPED runtime table, not the docs: `@kapso/
 *  whatsapp-cloud-api` 0.2.3 `dist/index.js` maps `[131047,
 *  "reengagementWindow"]` and gives that category `{action: "do_not_retry"}`. */
export const REENGAGEMENT_ERROR_CODE = 131047;

/** True when a send failed because the 24-hour service window has closed.
 *
 *  Meta only permits free-form messages within 24h of the user's last inbound
 *  message; outside it a send fails and — because the failure IS the inability
 *  to message the user — there is no way to tell them from inside the channel.
 *  It must therefore be loud in the log, and distinguishable from an ordinary
 *  dispatch failure, or the operator sees a bot that simply stopped answering.
 *
 *  MATCHES ON STRUCTURE, NEVER ON WORDING. The first version tested the error
 *  MESSAGE against /24-hour window/. That is wrong in both directions: Meta
 *  rewording or localising the string silently disables the branch, and any
 *  unrelated error whose text happens to contain the phrase — an agent reply
 *  quoted into an exception, for instance — would be misclassified as
 *  undeliverable and swallow a real failure, suppressing both the ⚠️ status and
 *  the apology. `GraphApiError` carries `category` and `code`; both are stable
 *  identifiers and neither is prose. (P20 round 1, BLOCKER + MAJOR.)
 *
 *  Deliberately NO text fallback. A wrapped/rethrown error that loses the
 *  structured fields degrades to "generic dispatch failure", which is exactly
 *  the pre-existing behaviour — whereas a text fallback reintroduces the
 *  false-positive this fix exists to remove. */
export function isOutsideServiceWindow(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { category?: unknown; code?: unknown };
  return err.category === "reengagementWindow" || err.code === REENGAGEMENT_ERROR_CODE;
}

/** Which Genesis workspace a thread's sessions are pinned to (BRO-2216).
 *
 *  Pure so the confinement is testable — it is a security boundary, not a
 *  convenience. A WhatsApp number is publicly messageable, so its sessions are
 *  pinned to a dedicated workspace; every other channel keeps the engine
 *  default. The direction that matters is the negative one: the WhatsApp
 *  workspace must never be applied to a non-WhatsApp thread, and the absence of
 *  config must never silently widen a channel's reach.
 *
 *  Returns undefined to mean "inherit the engine default" — never a fallback
 *  workspace, because guessing here would be guessing about confinement. */
export { tenantWorkspaceId };

export type WorkspaceDecision =
  /** Not a confined channel — use whatever workspace the engine defaults to. */
  | { kind: "inherit" }
  /** Confine this turn to `workspaceId`. */
  | { kind: "pin"; workspaceId: string }
  /** A confined channel we could NOT resolve a workspace for. Do not dispatch. */
  | { kind: "refuse"; reason: string };

export function workspaceDecisionFor(
  threadId: string,
  prefix: string | undefined,
): WorkspaceDecision {
  if (!threadId.startsWith("kapso:")) return { kind: "inherit" };

  const p = prefix?.trim();
  if (!p) {
    return {
      kind: "refuse",
      reason:
        "GENESIS_WHATSAPP_WORKSPACE_PREFIX is unset, so this turn has no tenant workspace to run in",
    };
  }

  // The SENDER, not our own number: principalOf takes waId (part 2) and
  // normalizes it to digits, so "+57 300..." and "57300..." are one tenant and
  // one directory. Reusing the allowlist decoder is deliberate — a second
  // parser here could disagree with the one that authorized the thread, and
  // the disagreement would be a sender served in another sender's workspace.
  const principal = principalOf(threadId, "kapso");
  if (principal === undefined || principal.channel !== "kapso") {
    return {
      kind: "refuse",
      reason: `cannot resolve a WhatsApp principal from thread id ${JSON.stringify(threadId)}`,
    };
  }

  return { kind: "pin", workspaceId: tenantWorkspaceId(principal, p) };
}

/** Which of `workspaceIds` are NOT registered+available in a GET /workspaces
 *  payload. Pure so the "every tenant, not just one" rule is covered by a test
 *  rather than only by a log line on a box. */
export function unregisteredTenants(payload: unknown, workspaceIds: readonly string[]): string[] {
  return workspaceIds.filter((id) => !workspaceIsRegistered(payload, id));
}

/** Back-compat shim for callers that only need the id.
 *
 *  DELIBERATELY collapses "refuse" to undefined and is therefore NOT safe on
 *  the dispatch path — undefined there means "inherit the engine default",
 *  i.e. the widest workspace on the box. Call `workspaceDecisionFor` and
 *  handle `refuse` explicitly wherever a turn is actually dispatched. */
export function workspaceIdFor(threadId: string, prefix: string | undefined): string | undefined {
  const d = workspaceDecisionFor(threadId, prefix);
  return d.kind === "pin" ? d.workspaceId : undefined;
}

/** Is `wantId` present in a Genesis `GET /workspaces` payload?
 *
 *  Exists because the engine binds an UNKNOWN workspaceId to the DEFAULT
 *  workspace rather than refusing (`Supervisor.resolve`: "unknown → default").
 *  Measured on the VPS 2026-08-22: `workspaceId: "ws-doesnotexist"` ran the
 *  agent in `/home/agent` — the broadest workspace on the box.
 *
 *  For most callers that fallback is a convenience. For a PUBLIC channel it is
 *  a silent widening: one typo in GENESIS_WHATSAPP_WORKSPACE_ID and WhatsApp
 *  gets the home directory while the bot still logs "pinned". We do not change
 *  the engine's semantics (other consumers depend on them) — the channel
 *  verifies its own confinement before serving.
 *
 *  Unrecognizable payload → false. Unverifiable is not "fine". */
export function workspaceIsRegistered(payload: unknown, wantId: string): boolean {
  const want = wantId.trim();
  if (!want) return false;
  if (typeof payload !== "object" || payload === null) return false;
  const list = (payload as { workspaces?: unknown }).workspaces;
  if (!Array.isArray(list)) return false;
  return list.some((w) => {
    if (typeof w !== "object" || w === null) return false;
    const entry = w as { id?: unknown; available?: unknown };
    if (entry.id !== want) return false;
    // `available: false` means the path is missing/unreadable — registered but
    // unusable, which the engine would also fall back from.
    return entry.available !== false;
  });
}

/** Parse a leading-slash command token + args, stripping a `@botname` suffix. */
export function parseCommand(text: string): { token: string; args: string } | undefined {
  const m = text.trim().match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (m?.[1] === undefined) return undefined;
  return { token: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
}

/** POST a /control action to Genesis. Returns the parsed JSON result. */
async function genesisControl(
  action: string,
  threadId: string,
  opts: HandlerOptions,
): Promise<{ ok: boolean; reason?: string; phase?: string; alive?: boolean }> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl}/control`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: JSON.stringify({ threadId, action }),
  });
  return (await res.json().catch(() => ({ ok: false }))) as {
    ok: boolean;
    reason?: string;
    phase?: string;
    alive?: boolean;
  };
}

/** Handle a control command. Returns true if it WAS a control command (handled
 *  here); false → not a control command, caller should dispatch to the agent. */
export async function handleControlCommand(
  thread: PostableThread,
  text: string,
  opts: HandlerOptions,
): Promise<boolean> {
  const parsed = parseCommand(text);
  if (parsed === undefined) return false;
  const action = controlAction(parsed.token);
  if (action === undefined) return false; // a skill/unknown command → not control

  switch (action) {
    case "help":
      await thread.post(renderHelp());
      return true;
    case "commands":
      await thread.post(
        renderCommandList(enumerateSessionCommands({ skillsDirs: opts.skillsDirs })),
      );
      return true;
    case "new": {
      const r = await genesisControl("reset", thread.id, opts);
      await thread.post(
        r.ok
          ? "🆕 Fresh conversation started — I've cleared my context for this chat."
          : "🆕 Nothing to reset yet — just send a message to begin.",
      );
      return true;
    }
    case "stop": {
      const r = await genesisControl("interrupt", thread.id, opts);
      await thread.post(r.ok ? "⏹️ Interrupted the current turn." : "Nothing is running right now.");
      return true;
    }
    case "status": {
      const r = await genesisControl("status", thread.id, opts);
      if (!r.ok) {
        await thread.post("No active session for this chat yet — send a message to start one.");
        return true;
      }
      await thread.post(`Session: *${r.alive ? "live" : "idle"}* · phase: \`${r.phase ?? "?"}\``);
      return true;
    }
    default:
      return false;
  }
}

/** Telegram setMyCommands payload for the native `/` menu (control set only). */
export function nativeCommandMenu(): Array<{ command: string; description: string }> {
  return CONTROL_COMMANDS.map((c) => ({ command: c.command, description: c.description }));
}

/** Stream a Genesis agent reply into `thread`, keyed to the thread's id for
 *  per-conversation continuity. Control commands are handled first; everything
 *  else (including skill commands) dispatches to the agent. Surfaces a failure
 *  as a posted message rather than throwing, so one bad turn never crashes. */
export async function handleAgentMessage(
  thread: PostableThread,
  text: string,
  opts: HandlerOptions,
  signals?: TurnSignals,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  // Control commands short-circuit (never reach the agent). No status marker
  // and no keep-alive: these answer in milliseconds, so a 👀 that is replaced
  // by ✅ in the same tick is visual noise, not feedback.
  if (await handleControlCommand(thread, trimmed, opts).catch(() => false)) return;

  // Acknowledge BEFORE the agent starts, cheapest signal first.
  //
  // ORDER AND AWAIT ARE BOTH DELIBERATE (P20 round 1, MAJOR). The first version
  // did `await setStatus("working")` ahead of the indicator, which put a
  // network round trip we do not control on the critical path of EVERY turn: a
  // hanging reaction call would delay the typing indicator and the agent
  // dispatch behind it, so the feedback layer could stall the product. The
  // reaction is now fired and not awaited, and typing starts first.
  //
  // Keep-alive runs ONLY on channels that buffer (WhatsApp). A streaming
  // channel shows progress by posting and editing as tokens arrive, so it
  // needs no indicator — and re-arming there would have been a behaviour change
  // on Telegram, which this change claims not to make.
  const buffered = opts.streaming === false;
  let stopTyping = () => {};
  if (buffered) {
    stopTyping = keepTyping(thread);
  } else {
    // Streaming channels keep the pre-existing single indicator: the stream
    // IS the progress display, so there is nothing for a keep-alive to add.
    // No longer awaited, so a hung indicator cannot stall the turn behind it.
    void thread.startTyping?.().catch(() => {});
  }
  void signals?.setStatus?.("working").catch(() => {});
  try {
    const stream = genesisStream({
      baseUrl: opts.baseUrl,
      threadId: thread.id,
      text: trimmed,
      token: opts.token,
      fetchImpl: opts.fetchImpl,
      workspaceId: opts.workspaceId,
    });
    if (opts.streaming === false) {
      // Buffered path: drain first, then post whole. Streaming here would post
      // a message and try to edit it, which this channel cannot do.
      const reply = await drainStream(stream);
      const chunks = chunkForWhatsapp(reply, opts.chunkTarget);
      if (chunks.length === 0) {
        // An empty reply must still say something — silence is indistinguishable
        // from the bot being down, which is the failure mode this whole channel
        // has to avoid.
        await thread.post("(the agent finished without producing any text)");
      } else {
        // Stop the indicator before the first send. WhatsApp dismisses it on
        // send anyway; re-arming between chunks would show "typing" after the
        // answer has already begun arriving.
        stopTyping();
        for (const chunk of chunks) await thread.post(chunk);
      }
    } else {
      await thread.post(stream);
    }
    await signals?.setStatus?.("done").catch(() => {});
  } catch (e) {
    if (isOutsideServiceWindow(e)) {
      // Distinct from an ordinary dispatch failure, and deliberately not
      // followed by a thread.post: the whole nature of this failure is that we
      // CANNOT message the user. Posting would fail identically and bury the
      // real cause under a second exception.
      console.error(
        `[genesis-bot] 24h service window CLOSED — the reply could not be delivered. WhatsApp only permits free-form messages within 24h of the user's last inbound message, and the sandbox number cannot send templates. The user saw NOTHING. thread=${thread.id}`,
        e,
      );
      return;
    }
    console.error("[genesis-bot] dispatch failed", e);
    await signals?.setStatus?.("failed").catch(() => {});
    await thread.post("⚠️ Something went wrong handling that — please try again.").catch(() => {});
  } finally {
    stopTyping();
  }
}
