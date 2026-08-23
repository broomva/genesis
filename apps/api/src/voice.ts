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

import { timingSafeEqual } from "node:crypto";

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
 *  or prefix through timing. Fail closed on absent/empty/mismatched-length. */
export function secretMatches(presented: string | undefined, expected: string): boolean {
  if (!expected) return false; // never authorize against an unset secret
  if (!presented) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on length mismatch, which would itself be an oracle.
  if (a.byteLength !== b.byteLength) return false;
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
  const request = clampRequest(input.request ?? "");
  if (!request) throw new VoiceValidationError("request is required and cannot be empty");

  const resolution = resolveCaller(input.callerId, principals);
  return {
    id,
    callerId: normalizeCallerId(input.callerId ?? ""),
    // Delivery target comes from the ALLOWLIST entry, never from the request
    // body: taking it from input would let a caller name someone else's number
    // and have our answer delivered to them.
    ...(resolution.kind === "known" ? { deliverTo: resolution.principal.id } : {}),
    request,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    createdAt: now,
  };
}
