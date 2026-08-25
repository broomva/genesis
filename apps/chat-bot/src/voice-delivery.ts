// Voice delivery leg (BRO-2284, BRO-2228 scope item 4).
//
// /voice/request records a ticket into queue.jsonl and, until now, nothing read
// it: a caller's request was written down and never answered. This drains the
// queue, runs the turn in that caller's own tenant workspace, and sends the
// answer to the number on file.
//
// WHY THIS DOES NOT MAKE THE FOLLOW-UP PROMISABLE.
// A phone call does not open a WhatsApp 24-hour service window. Meta only permits
// free-form messages within 24h of the user's last INBOUND message, and that
// state is discoverable only reactively — isOutsideServiceWindow classifies a
// send that already failed; nothing tracks it ahead of time. Checking it at
// intake would mean a cross-process API call on a path that must answer in under
// a second with a caller on the line.
//
// So delivery is BEST-EFFORT and /voice/request keeps returning followUp:"none".
// The `voiceDelivery` option deleted in BRO-2257 is deliberately NOT
// reintroduced: a promise made at intake can still be false at send time, and an
// unkeepable promise is the exact defect four review rounds were spent removing.
// The caller is told their message was written down. If an answer also arrives,
// that is a bonus, not a commitment.

import { isOutsideServiceWindow, renderForWhatsapp } from "./handler";

/** One queued request. Mirrors the producer's shape in apps/api/src/voice.ts —
 *  the two are separate apps, so this is a structural copy, and `parseQueue`
 *  below validates rather than trusts. */
export interface VoiceTicket {
  readonly id: string;
  readonly callerId: string;
  /** Absent when the caller was not recognized: nowhere to deliver TO. */
  readonly deliverTo?: string;
  readonly request: string;
  readonly conversationId?: string;
  readonly createdAt: string;
}

function isTicket(v: unknown): v is VoiceTicket {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    t.id.length > 0 &&
    typeof t.request === "string" &&
    t.request.length > 0 &&
    typeof t.callerId === "string" &&
    (t.deliverTo === undefined || typeof t.deliverTo === "string")
  );
}

/** Parse the append-only queue.
 *
 *  TOLERANT BY DESIGN. This reads a file another process is appending to, so the
 *  last line can be a partial write, and a single malformed line must not stop
 *  every later ticket from ever being answered. Unparseable lines are skipped and
 *  counted; the caller logs the count rather than discovering silence. */
export function parseQueue(raw: string): { tickets: VoiceTicket[]; skipped: number } {
  const tickets: VoiceTicket[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const v: unknown = JSON.parse(s);
      if (isTicket(v)) tickets.push(v);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { tickets, skipped };
}

export type Disposition =
  | { kind: "delivered" }
  | { kind: "undeliverable"; reason: "no-recipient" }
  | { kind: "failed"; reason: "window-closed" | "dispatch" | "send"; detail: string };

/** Tickets still needing work: not already handled, and not already in flight.
 *  Ordered oldest-first — a caller who rang twice gets answers in the order they
 *  asked, which is the only ordering they can make sense of. */
export function pendingTickets(
  tickets: readonly VoiceTicket[],
  handled: ReadonlySet<string>,
): VoiceTicket[] {
  const seen = new Set<string>();
  const out: VoiceTicket[] = [];
  for (const t of tickets) {
    // The id is STABLE across provider retries (voice.ts derives it from
    // conversationId+request), so the same ticket really can appear twice in the
    // file. Collapsing here is what makes that retry harmless.
    if (handled.has(t.id) || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

export interface DeliverDeps {
  /** Run the agent turn. Returns the answer text. */
  readonly dispatch: (ticket: VoiceTicket, workspaceId: string | undefined) => Promise<string>;
  /** Send to a phone number. Throws on failure; a closed window throws too. */
  /** `ticketId` labels the leak warning. Deliberately NOT the phone number:
   *  the warning's whole design is marker names and a length, and a recipient
   *  in a log line is a privacy regression the old path did not have. */
  readonly send: (to: string, text: string, ticketId: string) => Promise<void>;
  /** Which workspace the turn runs in — the caller's own tenant, so a voice
   *  request is confined exactly as their WhatsApp is. */
  readonly workspaceFor: (deliverTo: string) => string | undefined;
  readonly log?: (msg: string) => void;
}

export async function deliverTicket(t: VoiceTicket, deps: DeliverDeps): Promise<Disposition> {
  const log = deps.log ?? (() => {});
  if (!t.deliverTo) {
    // An unrecognized caller has nowhere to receive an answer. This is a normal
    // outcome, not an error — most callers are strangers — but it is RECORDED as
    // handled so the queue does not re-read it forever.
    log(`[voice] ${t.id}: no recipient (caller not on the allowlist); recording as handled`);
    return { kind: "undeliverable", reason: "no-recipient" };
  }

  let answer: string;
  try {
    answer = await deps.dispatch(t, deps.workspaceFor(t.deliverTo));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log(`[voice] ${t.id}: dispatch failed — ${detail}`);
    return { kind: "failed", reason: "dispatch", detail };
  }

  const text = answer.trim();
  if (!text) {
    // Send something rather than nothing: silence is indistinguishable from the
    // system having dropped the request, which is the failure this whole channel
    // exists to avoid.
    log(`[voice] ${t.id}: the turn produced no text`);
  }

  try {
    await deps.send(t.deliverTo, text || "(the agent finished without producing any text)", t.id);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (isOutsideServiceWindow(e)) {
      // Named specifically, because the diagnosis is actionable and completely
      // different from a transport error: WhatsApp forbids a free-form message
      // more than 24h after the user's last inbound one. A phone call does not
      // open that window. The caller was promised nothing, so nothing is broken —
      // but the operator should see WHY the answer went nowhere.
      const why =
        "A call does not open the window; the recipient must have messaged us on WhatsApp " +
        "within 24h. The caller was promised nothing, so no commitment was broken.";
      log(`[voice] ${t.id}: 24h service window CLOSED for ${t.deliverTo} — undelivered. ${why}`);
      return { kind: "failed", reason: "window-closed", detail };
    }
    log(`[voice] ${t.id}: send failed — ${detail}`);
    return { kind: "failed", reason: "send", detail };
  }

  log(`[voice] ${t.id}: answered ${t.deliverTo} (${text.length}c)`);
  return { kind: "delivered" };
}

// ── Persistence ────────────────────────────────────────────────────────────
//
// The queue is append-only and the producer never rewrites it, so "what has been
// handled" is OUR state, kept in a sibling append-only file. Latest entry per id
// wins, which makes the file a log rather than a set and lets an attempt count
// grow across restarts.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const HANDLED_FILE = "delivered.jsonl";

/** Attempts before a ticket is abandoned.
 *
 *  Deliberately LOW, because a retry is not cheap: every attempt re-runs the
 *  agent turn, which takes tens of seconds and real compute. Unbounded retry
 *  against a closed 24h window would re-run the same turn forever and never
 *  deliver it. Three is enough to ride out a transport blip and cheap enough to
 *  be wrong about. */
export const MAX_ATTEMPTS = 3;

export interface HandledEntry {
  readonly id: string;
  readonly at: string;
  readonly disposition: string;
  readonly attempts: number;
  /** Whether this ticket will be attempted again.
   *
   *  Written by the CONSUMER, which owns MAX_ATTEMPTS, so a reader does not have
   *  to re-derive it from a copy of that constant. The api serves this queue to
   *  the PWA and would otherwise need its own cap — two constants that must agree
   *  forever, in different apps, with nothing to catch the drift. Optional so an
   *  entry written before this field existed still parses. */
  readonly terminal?: boolean;
}

/** Read the log into a per-id view. Tolerant for the same reason parseQueue is. */
export function readHandled(path: string): Map<string, HandledEntry> {
  const out = new Map<string, HandledEntry>();
  if (!existsSync(path)) return out;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Unreadable is not fatal, for the same reason a corrupt line is not: the
    // in-memory attempt count still bounds cost, whereas throwing here would
    // stop the drain entirely and answer nobody.
    return out;
  }
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s) as HandledEntry;
      if (e && typeof e.id === "string" && e.id) out.set(e.id, e);
    } catch {
      // A partial or corrupt line loses one id's history, which at worst
      // redelivers. Refusing to start over it would lose everything.
    }
  }
  return out;
}

export function appendHandled(path: string, entry: HandledEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

/** Ids that must not be attempted again: succeeded, undeliverable, or out of
 *  attempts. A ticket still under the cap is NOT here — it gets another try. */
export function terminalIds(handled: ReadonlyMap<string, HandledEntry>): Set<string> {
  const out = new Set<string>();
  for (const [id, e] of handled) {
    // `terminal` when the writer recorded it; otherwise re-derive, so entries
    // written before the field existed still behave correctly.
    if (e.terminal === true) out.add(id);
    else if (e.disposition === "delivered" || e.disposition === "undeliverable") out.add(id);
    else if (e.attempts >= MAX_ATTEMPTS) out.add(id);
  }
  return out;
}

export interface DrainDeps extends DeliverDeps {
  readonly queueDir: string;
  readonly now?: () => string;
  /** In-memory attempt counts, owned by the caller and shared across passes.
   *
   *  The persisted log is the durable record, but it is not the ONLY one, and
   *  that matters: if appending fails — read-only volume, disk full — the attempt
   *  is forgotten and the next pass re-runs the agent turn, forever. The cap
   *  would then bound nothing at all, which is the opposite of its purpose. This
   *  bounds cost within the process even when nothing can be written down. */
  readonly attemptMemo?: Map<string, number>;
}

/** One pass over the queue. Returns what happened, for the caller to log or a
 *  test to assert. */
export async function drainOnce(deps: DrainDeps): Promise<{
  scanned: number;
  skippedLines: number;
  attempted: number;
  delivered: number;
  failed: number;
}> {
  const queuePath = join(deps.queueDir, "queue.jsonl");
  const handledPath = join(deps.queueDir, HANDLED_FILE);
  const now = deps.now ?? (() => new Date().toISOString());
  if (!existsSync(queuePath)) {
    return { scanned: 0, skippedLines: 0, attempted: 0, delivered: 0, failed: 0 };
  }
  const { tickets, skipped } = parseQueue(readFileSync(queuePath, "utf8"));
  const handled = readHandled(handledPath);
  const memo = deps.attemptMemo;
  const terminal = terminalIds(handled);
  // Fold in anything this process has already exhausted but could not persist.
  if (memo) for (const [id, n] of memo) if (n >= MAX_ATTEMPTS) terminal.add(id);
  const pending = pendingTickets(tickets, terminal);

  let delivered = 0;
  let failed = 0;
  for (const t of pending) {
    // Whichever record is higher: the file may be stale if a write failed.
    const prior = Math.max(handled.get(t.id)?.attempts ?? 0, memo?.get(t.id) ?? 0);
    const d = await deliverTicket(t, deps);
    // Recorded AFTER the send, never before. A crash in between redelivers,
    // which for a message to a human is strictly better than silence: they get
    // the answer twice instead of never. At-least-once is the deliberate choice.
    // Count it in memory FIRST, so the attempt survives a failed write.
    memo?.set(t.id, prior + 1);
    try {
      appendHandled(handledPath, {
        id: t.id,
        at: now(),
        disposition: d.kind === "failed" ? `failed:${d.reason}` : d.kind,
        attempts: prior + 1,
        terminal: d.kind !== "failed" || prior + 1 >= MAX_ATTEMPTS,
      });
    } catch (e) {
      // Loud, because the durable bound is gone until this is fixed: a restart
      // resets the in-memory count and the turn can run again.
      const why = e instanceof Error ? e.message : String(e);
      const caveat = "The attempt is counted in memory only, so a restart may re-run this turn.";
      (deps.log ?? (() => {}))(`[voice] ${t.id}: COULD NOT RECORD the outcome (${why}). ${caveat}`);
    }
    if (d.kind === "delivered") delivered++;
    else if (d.kind === "failed") failed++;
    if (d.kind === "failed" && prior + 1 >= MAX_ATTEMPTS) {
      const note =
        "The caller was promised nothing, so no commitment was broken — but this request is " +
        "now unanswered.";
      (deps.log ?? (() => {}))(
        `[voice] ${t.id}: ABANDONED after ${prior + 1} attempts (${d.reason}). ${note}`,
      );
    }
  }
  return {
    scanned: tickets.length,
    skippedLines: skipped,
    attempted: pending.length,
    delivered,
    failed,
  };
}

/** What the voice leg actually puts on the wire, as ONE testable function.
 *
 *  This exists because the wiring was otherwise unverifiable. The send closure
 *  lives inside startVoiceDelivery() in index.ts, which runs at module load, so
 *  no test could reach it — and a mutation giving the voice path a different
 *  chunk target passed the entire suite. A rendering invariant that no test can
 *  observe is a convention, not an invariant.
 *
 *  Routing through renderForWhatsapp is the point: the voice leg used to call
 *  markdownToWhatsApp with its own chunk-target arithmetic, so it was the one
 *  conversion site with no BRO-2267 leak check, and the two paths could drift
 *  with nothing to notice. */
export function voiceSendChunks(
  text: string,
  ticketId: string,
  warn?: (message: string) => void,
): string[] {
  // The label is the TICKET id, never the recipient. Review of the first attempt
  // caught `voice=${to}` putting a phone number into a warning whose whole
  // design is marker names and a length — a privacy regression the old path did
  // not have. `warn` is the seam that lets a test assert that, because a
  // mutation reducing the label to a constant otherwise passed the whole suite.
  const { chunks } = renderForWhatsapp(text, { label: `voice=${ticketId}`, warn });
  // An empty render still has to send something: silence is indistinguishable
  // from the system having dropped the request, which is the failure this whole
  // channel exists to avoid.
  return chunks.length ? chunks : [text];
}

/** Minimal slice of the WhatsApp client the sender needs. */
export interface VoiceWhatsapp {
  readonly messages: {
    sendText: (m: { phoneNumberId: string; to: string; body: string }) => Promise<unknown>;
  };
}

export interface VoiceSenderOptions {
  readonly wa: VoiceWhatsapp;
  readonly phoneNumberId: string;
  /** A send that accepts the connection and never answers would leave the drain
   *  flag set forever and starve every later ticket in silence. */
  readonly timeoutMs: number;
  /** Test seam for the leak warning; production leaves it unset. */
  readonly warn?: (message: string) => void;
}

/** Build the `send` the drain calls.
 *
 *  WHY THIS IS A FACTORY HERE RATHER THAN A CLOSURE IN index.ts. Review of the
 *  first attempt made the point precisely: extracting only the RENDERING moved
 *  the untestable boundary up one level rather than removing it. `index.ts`
 *  could still have called `[text]` instead of voiceSendChunks and every test
 *  would have passed, so "the two paths cannot drift" was still a claim no test
 *  could observe. Building the sender here means a test can pass a fake client
 *  and assert on the bodies that actually reach sendText — which is the only
 *  boundary that matters. index.ts is left with wiring and no logic. */
export function createVoiceSender(opts: VoiceSenderOptions) {
  return async (to: string, text: string, ticketId: string): Promise<void> => {
    for (const body of voiceSendChunks(text, ticketId, opts.warn)) {
      const bail = AbortSignal.timeout(opts.timeoutMs);
      await Promise.race([
        opts.wa.messages.sendText({ phoneNumberId: opts.phoneNumberId, to, body }),
        new Promise((_r, reject) => {
          bail.addEventListener("abort", () =>
            reject(new Error(`whatsapp send exceeded ${opts.timeoutMs}ms`)),
          );
        }),
      ]);
    }
  };
}
