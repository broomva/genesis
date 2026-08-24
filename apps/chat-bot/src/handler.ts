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
import { classifyDispatchFailure, dispatchFailureMessage } from "./dispatch-failure";
import { genesisStream } from "./genesis";
import { withStallTimeout } from "./stall-timeout";
import {
  FENCE_OVERHEAD,
  balanceFences,
  markdownToWhatsApp,
  residualMarkdown,
} from "./whatsapp-format";

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
  /** Abort a dispatch whose SSE stream shows no activity at all for this long.
   *  Liveness is measured from frames, not from emitted text, so a turn sitting in
   *  a long tool call is never cut off. Defaults to DEFAULT_STALL_MS. */
  stallMs?: number;
  /** Chunk size for the buffered path. Defaults to CHUNK_TARGET; clamped to
   *  WHATSAPP_TEXT_LIMIT by chunkForWhatsapp so a misconfiguration degrades to
   *  "less readable" rather than "rejected by the transport". */
  chunkTarget?: number;
  /** Typing re-arm interval. A seam, not a knob: at the 20s default a unit test
   *  finishes long before the second re-arm, so "streaming channels get ONE
   *  indicator, buffered channels get a keep-alive" is indistinguishable from
   *  "both get one" — the mutation sweep proved it by SURVIVING removal of the
   *  buffered gate. Shrinking the interval is what makes the claim falsifiable. */
  typingRearmMs?: number;
  /** Ceiling on one status update. Same kind of seam as typingRearmMs: at the
   *  10s default a hung-status test outlives the runner's own 5s timeout, so
   *  "a hung reaction cannot withhold the reply" could only be asserted by NOT
   *  hanging. Shrinking it lets the guarantee be exercised directly. */
  statusTimeoutMs?: number;
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

/** The whole outbound render, as ONE call: convert → leak-check → chunk →
 *  balance fences. It also EMITS the leak warning, which is the point.
 *
 *  It lives HERE rather than in whatsapp-format.ts because chunkForWhatsapp and
 *  CHUNK_TARGET are defined in this module while the converter and fence helpers
 *  are in that one; putting it there compiles to a circular import. index.ts
 *  already imports chunking from ./handler, so a second send path can adopt this
 *  without a new dependency edge.
 *
 *  WHAT THIS DOES AND DOES NOT GUARANTEE. An earlier draft claimed chunks were
 *  "obtainable only by having run the check". That was false and review said so:
 *  markdownToWhatsApp, chunkForWhatsapp and balanceFences all remain exported,
 *  so a caller can still assemble the pipeline by hand. This is a golden path,
 *  not an enforced invariant.
 *
 *  What it does buy is that the check cannot be silently DROPPED by a path that
 *  uses it. The first draft returned the finding for the caller to log, which
 *  meant destructuring only `chunks` quietly disabled it — an ignorable warning
 *  is an absent warning. So the warning is emitted here, and the caller supplies
 *  the label that makes it useful (a thread id, a voice ticket id) along with
 *  its chunk target. `warn` is a test seam; production leaves it unset.
 *
 *  THE STEP ORDER matters and each ordering was learned from a defect. Convert
 *  BEFORE chunking or a table splits across messages and loses its rows. Reserve
 *  FENCE_OVERHEAD or balancing pushes a chunk past the transport cap and the
 *  message is REJECTED, not truncated. Balance AFTER chunking or a fenced block
 *  straddling two messages shows an unmatched ``` in one and loses monospace in
 *  the next. The leak check is the one with no failure signal when omitted — the
 *  reply still arrives, just with `**` and `##` in it, which is how BRO-2267
 *  reached phones unnoticed.
 *
 *  A NON-EMPTY `leaked` IS RARE, REACHABLE, AND NOT ALWAYS A DEFECT — which took
 *  two review rounds and then a correction to get right. residualMarkdown runs on
 *  CONVERTED output, and for ordinary replies the converter leaves nothing to
 *  find, so the first draft's tests only ever asserted an empty result and an
 *  implementation returning `[]` unconditionally would have passed all of them.
 *  Probing for reachable non-empty cases found them — and then found they are
 *  the converter working correctly:
 *
 *    `\*\*x\*\*`  ->  `**x**`   escaping asks for a LITERAL `**x**`, and since
 *                            WhatsApp has no `**` syntax that is what displays
 *    `|---|`      ->  `|---|`  a delimiter row with no header is not a table;
 *                            it is prose the author wrote, delivered verbatim
 *
 *  So the check has an IRREDUCIBLE FALSE-POSITIVE CLASS: markdown the author
 *  deliberately escaped to show literally. It is not fixable by a better
 *  detector — once escaping is stripped, an intentional `**x**` and a leaked one
 *  are byte-identical, and nothing reading only the output can tell them apart.
 *
 *  That is accepted rather than papered over. The warning is advisory, names the
 *  marker, changes no delivery, and agents escape markdown rarely; the
 *  alternative — no detector at all — is how BRO-2267 shipped to phones for an
 *  unknown period. An operator seeing `MARKDOWN LEAK — **bold**` on a reply that
 *  deliberately quoted markdown syntax should read it as noise. */
export interface WhatsappRender {
  /** Ready to post, in order. */
  readonly chunks: string[];
  /** Markdown that survived conversion, by name. Empty is the normal case. */
  readonly leaked: string[];
  /** Rendered length. Never the text itself. */
  readonly chars: number;
}

export interface RenderOptions {
  /** Identifies the send in the warning — a thread id or a voice ticket id. */
  readonly label: string;
  readonly chunkTarget?: number;
  /** Injection seam for tests; defaults to console.warn. */
  readonly warn?: (message: string) => void;
}

export function renderForWhatsapp(text: string, opts: RenderOptions): WhatsappRender {
  const rendered = markdownToWhatsApp(text);
  // Computed BEFORE the chunks, so the code executes the order the comment
  // claims. Object-literal evaluation ran balanceFences first in the draft —
  // harmless, since both read `rendered`, but the doc was describing something
  // the code did not do.
  const leaked = residualMarkdown(rendered);
  if (leaked.length > 0) {
    // Marker NAMES and a length only — never the message text, which would put
    // user content in the journal to catch a formatting bug.
    (opts.warn ?? console.warn)(
      `[genesis-bot] MARKDOWN LEAK — ${leaked.join(", ")} survived conversion and is headed for delivery unrendered (BRO-2267 regression). ${opts.label} chars=${rendered.length}`,
    );
  }
  const target = (opts.chunkTarget ?? CHUNK_TARGET) - FENCE_OVERHEAD;
  return {
    chunks: balanceFences(chunkForWhatsapp(rendered, target)),
    leaked,
    chars: rendered.length,
  };
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
 *  than a new failure. (P20 round 1, BLOCKER.)
 *
 *  THIS IS A PER-TURN BOUND AND NOTHING MORE. It does not address concurrency:
 *  enough simultaneous turns still exhaust the window, and the calls that then
 *  fail are the replies. A process-wide feedback limiter was built for that and
 *  DELETED — it was an approximation of an upstream counter this process cannot
 *  observe (unaligned window phase, a reserve guessed rather than measured),
 *  and each review round found a new way the approximation was wrong. The
 *  correct fix is to gate on the `X-RateLimit-Remaining` header Kapso returns on
 *  every response, which needs the adapter to surface response headers the Chat
 *  SDK does not currently expose. Tracked on BRO-2256; stated here rather than
 *  approximated, because a limiter that is wrong in an unknown direction is
 *  worse than a documented bound. */
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
 *  `inFlight` prevents overlap. If a round trip takes longer than `rearmMs` the
 *  naive version issues a second request on top of the first, so the slower the
 *  API is the MORE requests it gets — the exact inversion you want under
 *  pressure. (P20 round 1, MAJOR.)
 *
 *  There is deliberately NO `stopped` flag. An earlier fix added one, claiming
 *  it made a late-landing call inert — that claim was false twice over, and the
 *  mutation sweep caught it by SURVIVING its removal. `clearInterval` means no
 *  timer callback can run again and `fire()` has no other caller, so the guard
 *  was unreachable; and a `markRead` already on the wire cannot be unsent by
 *  any flag.
 *
 *  KNOWN RESIDUE, not fixed because it is not fixable here (P20 round 2
 *  re-raised it and I am recording it rather than claiming otherwise): a
 *  re-arm issued microseconds before the reply can still land after it, showing
 *  "typing" on an answered conversation. Nothing in this process can recall an
 *  in-flight request, and WhatsApp exposes no stop-typing call — only `markRead`
 *  with an indicator, never without. The exposure is bounded: WhatsApp drops the
 *  indicator ~25s later on its own, and our next send drops it sooner. It is a
 *  cosmetic wart with a ceiling, not a stuck state, and it is stated here so the
 *  next reader does not mistake its absence for an oversight. */
export function keepTyping(
  thread: PostableThread,
  rearmMs: number = TYPING_REARM_MS,
  maxMs: number = TYPING_MAX_MS,
): () => void {
  if (!thread.startTyping) return () => {};
  let inFlight = false;
  const deadline = Date.now() + maxMs;

  const stop = () => clearInterval(timer);

  const fire = () => {
    if (inFlight) return;
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

/** Ceiling on a single status update.
 *
 *  Sequencing the statuses fixed an ordering race but created a liveness one:
 *  the chain awaits each link, so a `working` reaction that NEVER settles would
 *  block the terminal status forever — and, on the failure path, block the
 *  apology reply behind it. A feedback call must never be able to withhold the
 *  product. (P20 round 3, MAJOR.) */
export const STATUS_TIMEOUT_MS = 10_000;

/** Resolve `p`, or give up after `ms`. Never rejects: a feedback call that
 *  times out is dropped, exactly like one that fails. */
export async function withTimeout(p: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (!p) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      p,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch {
    // dropped
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** How a finished turn is marked on the user's own inbound message.
 *
 *  TERMINAL ONLY — there is deliberately no "working" state. An earlier version
 *  sent 👀 on receipt and replaced it on completion, and that ordering could not
 *  be made safe: the two reactions are independent API calls, and abandoning a
 *  slow one (which is all a timeout can do — an in-flight request cannot be
 *  cancelled) lets it land AFTER the terminal one and restore 👀 permanently.
 *  A status that says the turn never finished, on a turn that did, is worse than
 *  no status.
 *
 *  Nothing is lost by dropping it. The typing indicator already says "working",
 *  and it says so for the whole turn; what a reaction adds is a mark that
 *  OUTLIVES the indicator, telling you afterwards how the turn ended. One call,
 *  sent once, with nothing to race. (P20 round 4, MAJOR.) */
export type TurnStatus = "done" | "failed";

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

  let posting = false;
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
    stopTyping = keepTyping(thread, opts.typingRearmMs);
  } else {
    // Streaming channels keep the pre-existing single indicator: the stream
    // IS the progress display, so there is nothing for a keep-alive to add.
    // No longer awaited, so a hung indicator cannot stall the turn behind it.
    void thread.startTyping?.().catch(() => {});
  }
  // Exactly ONE status call per turn, at the end. No chain, no ordering, no
  // race — there is nothing for it to race against. Still bounded, so a hung
  // reaction cannot hold the turn open or, on the failure path, hold the
  // apology behind it.
  const setStatus = (status: TurnStatus): Promise<void> =>
    withTimeout(signals?.setStatus?.(status), opts.statusTimeoutMs ?? STATUS_TIMEOUT_MS);
  try {
    // Bounded by SILENCE, not by total duration: the timer resets on every chunk,
    // so a slow-but-progressing turn is never cut off. Without this a wedged
    // dispatch hangs forever, the catch below never runs, and the channel says
    // nothing at all — measured on 2026-08-23, where the stream opened and then
    // produced zero bytes for the 170s a client waited before giving up.
    // The controller is what actually closes the socket on a stall. Ending the
    // generator alone leaves the response body reader held, because a generator
    // suspended on a never-settling await cannot run its own cleanup.
    const dispatchAbort = new AbortController();
    // Liveness is measured from SSE FRAMES, not from emitted text. genesisStream
    // yields only text parts, so a turn inside a long tool call emits nothing while
    // being entirely healthy — a yield-based bound would abort it.
    let lastActivity = Date.now();
    const stream = withStallTimeout(
      genesisStream({
        baseUrl: opts.baseUrl,
        threadId: thread.id,
        text: trimmed,
        token: opts.token,
        fetchImpl: opts.fetchImpl,
        workspaceId: opts.workspaceId,
        signal: dispatchAbort.signal,
        onActivity: () => {
          lastActivity = Date.now();
        },
      }),
      opts.stallMs,
      {
        onStall: () => dispatchAbort.abort(),
        idleMs: () => Date.now() - lastActivity,
      },
    );
    if (opts.streaming === false) {
      // Buffered path: drain first, then post whole. Streaming here would post
      // a message and try to edit it, which this channel cannot do.
      const reply = await drainStream(stream);
      // One call: convert, leak-check (and warn), chunk, balance. The orderings
      // are each learned from a defect and the check has no failure signal when
      // omitted, so both live in renderForWhatsapp rather than at each site.
      const { chunks } = renderForWhatsapp(reply, {
        label: `thread=${thread.id}`,
        chunkTarget: opts.chunkTarget ?? CHUNK_TARGET,
      });
      posting = true;
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
      posting = true;
      await thread.post(stream);
    }
    await setStatus("done");
  } catch (e) {
    // Checked BEFORE classification (BRO-2245 x BRO-2256 merge). A closed
    // service window IS a posting failure, so classifyDispatchFailure would
    // reach it only as the catch-all "unknown" — and it has a specific, more
    // useful diagnosis than that, plus it must NOT post.
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
    // The class goes to the channel; the ERROR ITSELF only ever goes to the log.
    // A tenant on a shared number must not receive a raw message that could carry
    // a path, a hostname, or a token fragment.
    // A failure while POSTING is the channel, not Genesis. Reporting a
    // channel-side `TypeError("fetch failed")` as "the agent backend is not
    // reachable" would point an operator at the wrong system entirely.
    const kind = posting ? "unknown" : classifyDispatchFailure(e);
    console.error(`[genesis-bot] dispatch failed (${kind})`, e);
    await setStatus("failed");
    await thread.post(dispatchFailureMessage(kind)).catch(() => {});
  } finally {
    stopTyping();
  }
}
