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

import { isOutsideServiceWindow } from "./handler";

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
  readonly send: (to: string, text: string) => Promise<void>;
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
    await deps.send(t.deliverTo, text || "(the agent finished without producing any text)");
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
}

/** Read the log into a per-id view. Tolerant for the same reason parseQueue is. */
export function readHandled(path: string): Map<string, HandledEntry> {
  const out = new Map<string, HandledEntry>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
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
    if (e.disposition === "delivered" || e.disposition === "undeliverable") out.add(id);
    else if (e.attempts >= MAX_ATTEMPTS) out.add(id);
  }
  return out;
}

export interface DrainDeps extends DeliverDeps {
  readonly queueDir: string;
  readonly now?: () => string;
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
  const pending = pendingTickets(tickets, terminalIds(handled));

  let delivered = 0;
  let failed = 0;
  for (const t of pending) {
    const prior = handled.get(t.id)?.attempts ?? 0;
    const d = await deliverTicket(t, deps);
    // Recorded AFTER the send, never before. A crash in between redelivers,
    // which for a message to a human is strictly better than silence: they get
    // the answer twice instead of never. At-least-once is the deliberate choice.
    appendHandled(handledPath, {
      id: t.id,
      at: now(),
      disposition: d.kind === "failed" ? `failed:${d.reason}` : d.kind,
      attempts: prior + 1,
    });
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
