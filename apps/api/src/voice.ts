// Voice channel (BRO-2228) — the surface an ElevenLabs phone agent calls.
//
// SHAPE: voice for intake, WhatsApp for delivery. A Claude Code turn takes ~9s
// for a trivial command and 30s+ for real work (measured on srv1692698); a
// caller will not hold. So nothing here runs an agent. Every handler answers
// from state we already have, or ENQUEUES and returns immediately, and the
// answer is delivered later over a channel built for asynchrony.
//
// IDENTITY: `system__caller_id` is caller ID, which is spoofable, so it is a
// ROUTING HINT and never an authorization claim. What makes that safe is the
// delivery direction: results go to the number ON FILE, not to whoever is on
// the line. A spoofer causes the answer to be sent to the real owner's
// WhatsApp — they gain nothing and the owner sees an unrequested reply, which
// is a detection, not a breach. Any capability that does NOT have that property
// (acting on the caller's behalf, reading their data aloud) must not be added
// here without a second factor.

import { createHash, timingSafeEqual } from "node:crypto";

/** Digits-only form of a phone number. "+57 300 123-4567" -> "573001234567".
 *
 *  MUST agree with the WhatsApp allowlist's `normalizePhone` (BRO-2224,
 *  apps/chat-bot/src/allowlist.ts). The two are separate implementations today
 *  because chat-bot and api are separate apps and BRO-2224 is unmerged; if they
 *  ever disagree, a caller whose number IS allowlisted resolves as unknown and
 *  silently drops to take-a-message, with nothing reporting the mismatch.
 *  Consolidate into one shared module when #107 lands — see the drift test. */
export function normalizeCallerId(value: string): string {
  return value.replace(/\D/g, "");
}

/** Compare a presented secret against the expected one without leaking length
 *  or prefix through timing. Fail closed on absent/empty.
 *
 *  Both sides are HASHED FIRST. The obvious implementation compares the raw
 *  buffers and returns early when the lengths differ — but that early return is
 *  itself the length oracle the doc-comment promises to avoid, distinguishable
 *  by timing across repeated guesses of different lengths. Hashing makes both
 *  operands exactly 32 bytes, so the comparison is constant-time in the only
 *  dimension an attacker controls. (P20 Strata A, round 1.) */
export function secretMatches(presented: string | undefined, expected: string): boolean {
  if (!expected) return false; // never authorize against an unset secret
  if (!presented) return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** A principal the voice channel may deliver to. Mirrors the WhatsApp allowlist
 *  entry: a channel-qualified id we already trust to receive messages. */
export interface DeliverablePrincipal {
  /** Digits-only phone number. */
  readonly id: string;
  /** Display name, if we have one. Never derived from the caller. */
  readonly name?: string;
}

export type CallerResolution =
  | { kind: "known"; principal: DeliverablePrincipal }
  | { kind: "unknown" };

/** Resolve a caller against the principals we can deliver to.
 *
 *  Unknown is NOT an error and must not be treated as one: most callers are
 *  strangers, and the agent's correct behaviour for them is to take a message.
 *  Returning an error here would push the agent toward apologising on the phone
 *  for a state that is entirely normal. */
export function resolveCaller(
  callerId: string | undefined,
  principals: readonly DeliverablePrincipal[],
): CallerResolution {
  if (!callerId) return { kind: "unknown" };
  const id = normalizeCallerId(callerId);
  if (!id) return { kind: "unknown" };
  const hit = principals.find((p) => p.id === id);
  return hit ? { kind: "known", principal: hit } : { kind: "unknown" };
}

/** One queued piece of work. Append-only; the delivery leg consumes it. */
export interface VoiceTicket {
  readonly id: string;
  /** Digits-only caller id as presented. Recorded for triage, NOT trusted. */
  readonly callerId: string;
  /** Where the answer will be delivered, when the caller was recognized. */
  readonly deliverTo?: string;
  readonly request: string;
  readonly conversationId?: string;
  readonly createdAt: string;
}

/** Cap the request text so a long or hostile transcript cannot blow up the
 *  queue file or the prompt it later becomes. Truncation is marked so a
 *  downstream reader never mistakes a cut transcript for a complete one. */
export const MAX_REQUEST_CHARS = 2000;

/** Caps for the fields that are persisted but NOT clamped by clampRequest. Only
 *  `request` was bounded originally, so an authenticated webhook could send a
 *  100 MB conversationId and have it buffered and appended verbatim. These are
 *  generous relative to any real caller id / provider conversation id. */
export const MAX_CALLER_ID_CHARS = 64;
export const MAX_CONVERSATION_ID_CHARS = 200;

/** Accept a string field from external JSON, or reject it in a way the agent can
 *  read to the caller. `input.request ?? ""` followed by .trim() throws a
 *  TypeError on `{"request": 42}` — a 500 mid-call, where a 400 with a fixable
 *  message is what the phone flow needs. (P20 Strata A, round 1.) */
function asString(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new VoiceValidationError(`${field} must be text`);
  }
  if (value.length > max) {
    throw new VoiceValidationError(`${field} is too long`);
  }
  return value;
}

export function clampRequest(text: string): string {
  const t = text.trim();
  return t.length <= MAX_REQUEST_CHARS ? t : `${t.slice(0, MAX_REQUEST_CHARS)}… [truncated]`;
}

export class VoiceValidationError extends Error {}

/** Build a ticket from a tool call. Throws VoiceValidationError on input the
 *  agent should be told to fix; its message is SAFE to return to the caller. */
export function buildTicket(
  input: { callerId?: string; request?: string; conversationId?: string },
  principals: readonly DeliverablePrincipal[],
  now: string,
  id: string,
): VoiceTicket {
  // Validate BEFORE clamping: clampRequest calls .trim(), which throws on a
  // non-string and turns a malformed tool call into a 500 mid-phone-call.
  const rawRequest = asString(input.request, "request", MAX_REQUEST_CHARS * 4);
  const callerId = asString(input.callerId, "callerId", MAX_CALLER_ID_CHARS);
  const conversationId = asString(
    input.conversationId,
    "conversationId",
    MAX_CONVERSATION_ID_CHARS,
  );
  const request = clampRequest(rawRequest);
  if (!request) throw new VoiceValidationError("request is required and cannot be empty");

  const resolution = resolveCaller(callerId, principals);
  return {
    // IDEMPOTENCY (P20 Strata A, round 1). A webhook tool call is retried when
    // the first response is lost, and a fresh UUID per attempt turned one caller
    // request into N tickets — N agent runs and N WhatsApp messages. When the
    // provider gives us a conversation id, derive the id from it plus the
    // request text so a retry lands on the SAME ticket and the delivery leg can
    // collapse duplicates on id alone. With no conversation id there is nothing
    // stable to key on, so the caller-supplied random id stands.
    id: conversationId
      ? `v-${createHash("sha256").update(`${conversationId}\u0000${request}`).digest("hex").slice(0, 32)}`
      : id,
    callerId: normalizeCallerId(callerId),
    // Delivery target comes from the ALLOWLIST entry, never from the request
    // body: taking it from input would let a caller name someone else's number
    // and have our answer delivered to them.
    ...(resolution.kind === "known" ? { deliverTo: resolution.principal.id } : {}),
    request,
    ...(conversationId ? { conversationId } : {}),
    createdAt: now,
  };
}
