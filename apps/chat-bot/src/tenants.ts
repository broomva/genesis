// Tenant registry (BRO-2230) — who the WhatsApp channel serves, as DATA.
//
// Replaces GENESIS_WHATSAPP_ALLOWED_USERS. An env var cannot express state,
// cannot record when someone was approved, cannot be changed without a restart,
// and cannot be audited — all of which a registry of 10-100 people needs.
//
// The number is open to REQUESTS, not to sessions. An unknown sender is
// recorded as `pending` and told so once; only an operator approval turns that
// into a workspace. That keeps the data-driven shape while never handing a
// session to someone unvetted on a box where tenants still share a uid and a
// kernel (the microVM substrate is what removes that — BRO-2224 phase 2).

import { type Principal, principalOf } from "./allowlist";

export type TenantState = "pending" | "active" | "suspended";

export interface TenantRecord {
  /** Digits-only phone number. The registry key. */
  readonly id: string;
  readonly channel: "kapso";
  readonly state: TenantState;
  /** Display name if the channel gave us one. Never trusted for anything. */
  readonly name?: string;
  readonly requestedAt: string;
  /** Set when the ONE acknowledgement was sent, so it is never sent twice. */
  readonly acknowledgedAt?: string;
  readonly approvedAt?: string;
  readonly suspendedAt?: string;
  readonly lastSeenAt?: string;
  readonly note?: string;
}

/** What to do with an inbound message. */
export type AdmitDecision =
  /** Serve it: an active tenant with a provisioned workspace. */
  | { kind: "serve"; tenant: TenantRecord }
  /** Record the request and send the single acknowledgement. */
  | { kind: "acknowledge"; tenant: TenantRecord }
  /** Do nothing at all, and say why in the log. */
  | { kind: "ignore"; reason: string };

/** Decide what happens to a message from `threadId`.
 *
 *  SILENCE IS DELIBERATE for every case except the first contact. A number that
 *  replies to every message from every sender is a spam amplifier: anyone who
 *  finds it can make it emit traffic, and a suspended tenant learns exactly
 *  when they were suspended. One acknowledgement per requester, ever. */
export function admit(
  threadId: string,
  lookup: (id: string) => TenantRecord | undefined,
  now: string,
): AdmitDecision {
  const principal: Principal | undefined = principalOf(threadId, "kapso");
  if (principal === undefined || principal.channel !== "kapso") {
    // Unresolvable is DENIED, never provisionally admitted: a thread id we
    // cannot attribute is one we cannot key a workspace on either.
    return { kind: "ignore", reason: `unresolvable thread id ${JSON.stringify(threadId)}` };
  }

  const existing = lookup(principal.id);
  if (!existing) {
    return {
      kind: "acknowledge",
      tenant: {
        id: principal.id,
        channel: "kapso",
        state: "pending",
        requestedAt: now,
        acknowledgedAt: now,
        lastSeenAt: now,
      },
    };
  }

  switch (existing.state) {
    case "active":
      return { kind: "serve", tenant: { ...existing, lastSeenAt: now } };
    case "pending":
      // Already asked. Repeating the acknowledgement on every message would
      // turn one requester into unbounded outbound traffic.
      return { kind: "ignore", reason: `tenant ${existing.id} is pending approval` };
    case "suspended":
      return { kind: "ignore", reason: `tenant ${existing.id} is suspended` };
  }
}

export class TenantTransitionError extends Error {}

/** Approve a request. Only `pending` and `suspended` can become active — an
 *  already-active tenant is left ALONE rather than re-stamped, so approving
 *  twice cannot silently reset `approvedAt` and lose the original audit date. */
export function approve(t: TenantRecord, now: string, note?: string): TenantRecord {
  if (t.state === "active") return t;
  return {
    ...t,
    state: "active",
    approvedAt: now,
    ...(note ? { note } : {}),
    suspendedAt: undefined,
  };
}

/** Suspend a tenant. Works from any state, including `pending` (a rejection).
 *  Deliberately keeps the record: deleting it would make the next message from
 *  that number look like a fresh request and re-acknowledge a rejected person. */
export function suspend(t: TenantRecord, now: string, note?: string): TenantRecord {
  return { ...t, state: "suspended", suspendedAt: now, ...(note ? { note } : {}) };
}

// --- rate limiting ---------------------------------------------------------

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Milliseconds until the oldest in-window hit expires. 0 when allowed. */
  readonly retryAfterMs: number;
}

/** Sliding-window limiter over a tenant's recent message timestamps.
 *
 *  Sliding, not fixed-bucket: a fixed window lets someone send `max` at the end
 *  of one bucket and `max` again at the start of the next, i.e. 2x the limit in
 *  an instant, which is exactly the burst the limit exists to stop. */
export function rateLimit(
  timestampsMs: readonly number[],
  nowMs: number,
  windowMs: number,
  max: number,
): RateLimitDecision {
  if (max <= 0) return { allowed: false, retryAfterMs: windowMs };
  const cutoff = nowMs - windowMs;
  const inWindow = timestampsMs.filter((t) => t > cutoff);
  if (inWindow.length < max) return { allowed: true, retryAfterMs: 0 };
  const oldest = Math.min(...inWindow);
  return { allowed: false, retryAfterMs: Math.max(1, oldest + windowMs - nowMs) };
}

/** Keep a bounded history: only the window matters, and an unbounded array
 *  grows forever for a chatty tenant. */
export function pruneTimestamps(
  timestampsMs: readonly number[],
  nowMs: number,
  windowMs: number,
): number[] {
  const cutoff = nowMs - windowMs;
  return timestampsMs.filter((t) => t > cutoff);
}
