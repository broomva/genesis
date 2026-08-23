// Voice queue (BRO-2228) — the sink that makes the voice intake surface REACHABLE.
//
// WHY THIS FILE EXISTS. The intake surface landed first (voice.ts + the routes in
// server.ts) with `enqueueVoice` as an unbound optional. No entrypoint passed it —
// and no entrypoint passed `voiceSecret` either, so `if (opts.voiceSecret)` never
// ran and the routes were never registered in ANY real deploy. Seventeen unit
// tests and eight route tests all passed against a surface no caller could reach:
// a gate that never executes (BRO-2226). This file plus the index.ts wiring is
// what closes that.
//
// FAILURE POLICY — deliberately the OPPOSITE of printTrace's. The per-event trace
// swallows every write error because observability must never break a turn. This
// must not swallow. A dropped ticket is a follow-up we promised out loud on a
// phone call and then silently cannot deliver, and /voice/request already turns a
// throw into an honest 503 ("could not record the request; please try again")
// that the agent reads to the caller. Propagating is what makes that 503 true.

import { appendFileSync, mkdirSync } from "node:fs";
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

/** Where tickets land. Append-only JSONL, one ticket per line — the shape
 *  voice.ts's VoiceTicket doc ("Append-only; the delivery leg consumes it")
 *  already promised, and the same on-disk convention as the session traces. */
export const VOICE_QUEUE_FILE = "queue.jsonl";

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
