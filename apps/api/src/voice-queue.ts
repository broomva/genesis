// Voice queue (BRO-2228) — the sink that makes the voice intake surface REACHABLE.
//
// WHY THIS FILE EXISTS. The intake surface landed first (voice.ts + the routes in
// server.ts) with `enqueueVoice` as an unbound optional. No entrypoint passed it —
// and no entrypoint passed `voiceSecret` either, so `if (opts.voiceSecret)` never
// ran and the routes were never registered in ANY real deploy. Seventeen unit
// tests and eight route tests all passed against a surface no caller could reach:
// a gate that never executes. This file plus the index.ts wiring is
// what closes that.
//
// FAILURE POLICY — deliberately the OPPOSITE of printTrace's. The per-event trace
// swallows every write error because observability must never break a turn. This
// must not swallow. A dropped ticket is a request the caller was told we
// recorded and which then silently vanished — and once a delivery leg exists, a
// follow-up promised out loud that never comes. /voice/request already turns a
// throw into an honest 503 ("could not record the request; please try again")
// that the agent reads to the caller. Propagating is what makes that 503 true.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type DeliverablePrincipal, type VoiceTicket, normalizeCallerId } from "./voice";

/** Parse GENESIS_VOICE_PRINCIPALS: comma-separated `number` or `number:Name`.
 *
 *  Same grammar family as GENESIS_WHATSAPP_ALLOWED_USERS (apps/chat-bot/src/
 *  allowlist.ts parseAllowlist) — comma-separated entries, `:` splitting an
 *  entry's qualifier from its id — so an operator configuring both channels
 *  writes the same shape twice instead of learning two formats.
 *
 *  Ids are normalized HERE, at parse time, and that is load-bearing rather than
 *  tidy: resolveCaller() normalizes the presented caller id and compares it
 *  against `principal.id` verbatim. An operator writing the natural "+57 300
 *  123-4567" into the env would otherwise store a principal that NOTHING can
 *  ever match, and the failure is silent — every caller resolves unknown and
 *  drops to take-a-message, which looks exactly like a stranger calling. */
export function parseVoicePrincipals(raw: string | undefined): DeliverablePrincipal[] {
  if (!raw) return [];
  const out: DeliverablePrincipal[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Split on the FIRST colon only: a display name may legitimately contain one
    // ("Carlos: on call"), and losing the tail would silently rename a principal.
    const sep = trimmed.indexOf(":");
    const rawId = sep === -1 ? trimmed : trimmed.slice(0, sep);
    const name = sep === -1 ? "" : trimmed.slice(sep + 1).trim();
    const id = normalizeCallerId(rawId);
    // An entry with no digits is a typo, not a principal. Keeping it would put an
    // id in the list that resolveCaller can never return, and an EMPTY id would
    // be worse than useless — it is the value normalizeCallerId yields for
    // garbage input, so it would collide with every unparseable caller.
    if (!id) continue;
    if (seen.has(id)) continue; // last-writer-wins would make order significant
    seen.add(id);
    out.push(name ? { id, name } : { id });
  }
  return out;
}

/** DURABILITY IS BEST-EFFORT, and that is a real limit rather than an oversight.
 *  appendFileSync returns once the write reaches the page cache, not the platter,
 *  so a host or power loss can lose a ticket the caller was already told we
 *  recorded. Two things make that acceptable TODAY and stop being true later:
 *  the route promises no follow-up at all (there is no way to make it), and
 *  Genesis runs a single process, where a synchronous append on a single-threaded
 *  runtime cannot interleave with another writer. The change that adds a
 *  queue-draining consumer — the moment a caller is told an answer IS coming — is
 *  the change that must add an fsync or a real queue; a second writing process
 *  needs record locking.
 *  (P20 Strata A, round 2.) */

/** Where tickets land. Append-only JSONL, one ticket per line — the shape
 *  voice.ts's VoiceTicket doc ("Append-only; the delivery leg consumes it")
 *  already promised, and the same on-disk convention as the session traces. */
export const VOICE_QUEUE_FILE = "queue.jsonl";

/** The consumer's log of what became of each ticket.
 *
 *  MUST equal apps/chat-bot/src/voice-delivery.ts HANDLED_FILE. The two apps do
 *  not share a module, so this is a second declaration of one name — the same
 *  situation normalizeCallerId is in, and it fails the same way: silently, by
 *  reading an empty queue and reporting every ticket pending. The drift test
 *  below pins them together. */
export const HANDLED_FILE = "delivered.jsonl";

/** Only for rows written BEFORE HandledEntry gained `terminal`. Current rows
 *  carry the flag, so this is never consulted for them — which is the point:
 *  duplicating the consumer's cap is a drift risk, and confining it to legacy
 *  rows keeps that risk from growing. */
const MAX_ATTEMPTS_FALLBACK = 3;

/** Build the enqueue sink. The directory is created ONCE here rather than per
 *  append: /voice/request runs with a caller on the line, so the hot path is one
 *  append and nothing else. */
export function createVoiceQueue(dir: string): (ticket: VoiceTicket) => void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, VOICE_QUEUE_FILE);
  return (ticket: VoiceTicket) => {
    // No try/catch: see FAILURE POLICY above. A throw here becomes the 503.
    appendFileSync(file, `${JSON.stringify(ticket)}\n`);
  };
}

// ── Operator view (BRO-2284) ───────────────────────────────────────────────
//
// The queue is two append-only files written by two processes: the api records
// tickets, the chat-bot records what became of them. Neither is readable as a
// STATE without joining them, and until now the only way to see a failure was to
// ssh in and read a journal. This is the join, served to the PWA.

/** What happened to a ticket, from the operator's point of view. */
export type VoiceStatus =
  | "pending" // nothing has tried it yet
  | "delivered" // answered on WhatsApp
  | "undeliverable" // the caller was not recognized: nowhere to send
  | "retrying" // failed, but will be attempted again
  | "abandoned"; // failed and will not be attempted again

export interface VoiceQueueEntry {
  readonly id: string;
  readonly callerId: string;
  readonly deliverTo?: string;
  readonly request: string;
  readonly createdAt: string;
  readonly status: VoiceStatus;
  readonly attempts: number;
  readonly lastAttemptAt?: string;
  /** For a failure, WHY — "window-closed" | "dispatch" | "send". The first is the
   *  one worth surfacing: it means the recipient has not messaged us in 24h, and
   *  no amount of retrying changes that. */
  readonly reason?: string;
}

interface RawHandled {
  id: string;
  at: string;
  disposition: string;
  attempts: number;
  terminal?: boolean;
}

function isHandled(v: unknown): v is RawHandled {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === "string" && e.id.length > 0 && typeof e.disposition === "string";
}

/** Join queue.jsonl with delivered.jsonl. Newest ticket first, because an
 *  operator opening this is asking "what just happened", not "what happened
 *  first". Tolerant of both files for the same reason parseQueue is: they are
 *  being appended to by another process while this reads them. */
export function readQueueStatus(dir: string): { entries: VoiceQueueEntry[]; degraded?: string } {
  let degraded: string | undefined;
  const readLines = (name: string): unknown[] => {
    const p = join(dir, name);
    let raw: string;
    try {
      // Read FIRST rather than existsSync-then-read. existsSync answers false for
      // a path it cannot stat — an unreadable parent directory, for instance — so
      // gating on it turned "I am not allowed to look" into "there is nothing
      // here", which is the exact silent lie the degraded flag exists to prevent.
      raw = readFileSync(p, "utf8");
    } catch (e) {
      const code = (e as { code?: string })?.code;
      // ENOENT is the ONLY healthy absence. Everything else is degradation.
      if (code === "ENOENT") return [];
      // The name, never the path: the message reaches a browser and the absolute
      // queue location is not the client's business.
      degraded = `${name} could not be read (${code ?? "unknown error"})`;
      return [];
    }
    const out: unknown[] = [];
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s));
      } catch {
        // Skipped, never fatal — see parseQueue.
      }
    }
    return out;
  };

  const handled = new Map<string, RawHandled>();
  for (const v of readLines(HANDLED_FILE)) if (isHandled(v)) handled.set(v.id, v);

  const seen = new Set<string>();
  const entries: VoiceQueueEntry[] = [];
  for (const v of readLines(VOICE_QUEUE_FILE)) {
    if (!v || typeof v !== "object") continue;
    const t = v as Record<string, unknown>;
    if (typeof t.id !== "string" || !t.id || typeof t.request !== "string") continue;
    // A stable id can appear twice (a provider retry); show the ticket once.
    if (seen.has(t.id)) continue;
    seen.add(t.id);

    const h = handled.get(t.id);
    const [kind, reason] = (h?.disposition ?? "").split(":");
    // An entry written before `terminal` existed has none, and reading that as
    // "will retry" tells the operator the opposite of what the consumer will do —
    // it treats attempts >= its cap as terminal. Re-derive when the flag is
    // absent. MAX_ATTEMPTS_FALLBACK duplicates the consumer's cap and is used
    // ONLY for those legacy rows; current rows carry `terminal` and never reach it.
    const exhausted =
      h?.terminal === undefined ? (h?.attempts ?? 0) >= MAX_ATTEMPTS_FALLBACK : h.terminal;
    const status: VoiceStatus = !h
      ? "pending"
      : kind === "delivered"
        ? "delivered"
        : kind === "undeliverable"
          ? "undeliverable"
          : exhausted
            ? "abandoned"
            : "retrying";

    entries.push({
      id: t.id,
      callerId: typeof t.callerId === "string" ? t.callerId : "",
      ...(typeof t.deliverTo === "string" ? { deliverTo: t.deliverTo } : {}),
      request: t.request,
      createdAt: typeof t.createdAt === "string" ? t.createdAt : "",
      status,
      attempts: typeof h?.attempts === "number" ? h.attempts : 0,
      ...(h?.at ? { lastAttemptAt: h.at } : {}),
      ...(reason ? { reason } : {}),
    });
  }
  entries.reverse();
  return degraded ? { entries, degraded } : { entries };
}
