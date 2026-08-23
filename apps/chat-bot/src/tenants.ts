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

/** How much of the harness a tenant gets.
 *
 *  Both tiers keep the OS sandbox. The tier chooses the PERMISSION mode only,
 *  because the two dials are independent and conflating them is what makes
 *  "give them web access" read as "turn the cage off":
 *
 *    confined  `defaultMode: "default"` — every tool not pre-allowed fails
 *              closed. Under `claude -p` there is no prompt to answer, so an
 *              un-allowed tool is simply unavailable and the agent cannot say
 *              how to grant it.
 *    trusted   `defaultMode: "bypassPermissions"` — tools are ungated, which
 *              removes the approval friction entirely. Deny rules still block
 *              (they apply in EVERY mode) and the sandbox still confines the
 *              filesystem to the tenant dir and egress to `domains`.
 *
 *  There is deliberately no tier that disables the sandbox. That would let a
 *  tenant `cat ~/broomva/crm/*` and read the operator's gh/railway tokens,
 *  because deny rules govern the file TOOLS and never Bash. */
export type TenantPolicy = "confined" | "trusted";

export const TENANT_POLICIES: readonly TenantPolicy[] = ["confined", "trusted"];

/** The tier a record without an explicit policy runs at. Confined, so a
 *  registry written before this field existed does not silently widen. */
export const DEFAULT_TENANT_POLICY: TenantPolicy = "confined";

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
  /** Permission tier. Absent means `DEFAULT_TENANT_POLICY`. */
  readonly policy?: TenantPolicy;
  /** Domains this tenant may reach, as approved one at a time. Feeds BOTH the
   *  sandbox network allowlist (Bash: curl, npx, git) and the `WebFetch(domain:)`
   *  permission rules (the in-process fetch tool), because those are two
   *  separate egress paths and opening one does not open the other. */
  readonly domains?: readonly string[];
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

// --- egress allowlist ------------------------------------------------------

/** Hard cap on a tenant's approved domains. An unbounded list is a settings
 *  file that grows until it is nobody's job to read, which is how an allowlist
 *  stops being one. */
export const MAX_TENANT_DOMAINS = 64;

/** Egress every tenant gets, because without it the workspace cannot install
 *  or run a skill and is a shell with no package manager. Deliberately the
 *  toolchain and nothing else: no docs sites, no APIs, no model providers.
 *  Everything past this is approved one domain at a time.
 *
 *  `github.com` is here with its eyes open. It is the skills/registry transport,
 *  and it is also a place a tenant can PUSH to. An allowlist bounds where data
 *  can go, never what can go there — the tenant's own workspace is exfiltratable
 *  to any allowed host by design, and that was the accepted trade. */
export const BASE_EGRESS_DOMAINS: readonly string[] = [
  "skills.sh",
  "*.skills.sh",
  "registry.npmjs.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
];

/** Every domain a tenant may reach: the shared toolchain plus its own approvals.
 *  Sorted and de-duplicated so a settings file is stable across re-provisions
 *  and a diff means a real policy change rather than a reordering. */
export function egressDomainsFor(t: TenantRecord): string[] {
  return [...new Set([...BASE_EGRESS_DOMAINS, ...(t.domains ?? [])])].sort();
}

/** The host a `WebFetch(domain:)` rule should name for an allowlist entry.
 *  The sandbox understands `*.example.com`; the permission rule is matched on
 *  the host itself, so the wildcard is stripped rather than passed through as a
 *  literal that would match no hostname at all. */
export function webFetchHost(domain: string): string {
  return domain.startsWith("*.") ? domain.slice(2) : domain;
}

/** A label: alphanumeric with interior hyphens, 1-63 chars, per RFC 1035. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Normalize an operator-proposed domain, or return undefined to REJECT it.
 *
 *  This string lands in a settings file that defines a security boundary, and
 *  under the request-over-WhatsApp flow the text originates with the TENANT —
 *  the operator only says yes. So it is validated as hostile input, not tidied:
 *  a value we cannot parse is refused, never "cleaned up" into something that
 *  parses but means something else.
 *
 *  Rejects, specifically:
 *    - anything carrying a scheme, path, port, query, or userinfo, because
 *      `evil.com/#.github.com` and `github.com:8443@evil.com` both read as a
 *      trusted host to a human skimming an approval message;
 *    - a wildcard covering a public suffix (`*`, `*.com`, `*.co.uk` is NOT
 *      caught here — see below), which would open a whole TLD in one approval;
 *    - bare hostnames with no dot, which match nothing useful and would let
 *      `localhost` through.
 *
 *  It does NOT try to know the public-suffix list: `*.co.uk` has two labels
 *  after the wildcard and is accepted. That is a real limit, and the reason the
 *  approval stays a human decision rather than becoming automatic. */
export function normalizeDomain(raw: string): string | undefined {
  const d = raw.trim().toLowerCase();
  if (d.length === 0 || d.length > 253) return undefined;
  // Reject the delimiters that let one string look like two different hosts.
  if (/[/\\:@?#\s,]/.test(d)) return undefined;

  const wildcard = d.startsWith("*.");
  const host = wildcard ? d.slice(2) : d;
  if (host.length === 0) return undefined;
  // A wildcard must leave a registrable name behind it. `*.com` is one label
  // and would hand over every .com in a single yes.
  const labels = host.split(".");
  if (labels.length < 2) return undefined;
  if (!labels.every((l) => LABEL.test(l))) return undefined;
  // A TLD is alphabetic; this also rejects a bare IPv4, which would otherwise
  // pass the label test and is never what an approval message means.
  const tld = labels[labels.length - 1] ?? "";
  if (!/^[a-z]{2,}$/.test(tld)) return undefined;
  return d;
}

export class TenantDomainError extends Error {}

/** Approve one domain for a tenant. Idempotent: re-approving is a no-op rather
 *  than a duplicate, so the operator saying yes twice cannot grow the file. */
export function allowDomain(t: TenantRecord, raw: string, now: string): TenantRecord {
  const domain = normalizeDomain(raw);
  if (domain === undefined) {
    throw new TenantDomainError(`not a domain this can approve: ${JSON.stringify(raw)}`);
  }
  const current = t.domains ?? [];
  if (current.includes(domain)) return t;
  if (current.length >= MAX_TENANT_DOMAINS) {
    throw new TenantDomainError(
      `tenant ${t.id} already has ${current.length} domains (max ${MAX_TENANT_DOMAINS})`,
    );
  }
  return { ...t, domains: [...current, domain].sort(), lastSeenAt: t.lastSeenAt ?? now };
}

/** Revoke a domain. Present because an allowlist you cannot shrink is one
 *  nobody will risk growing. */
export function denyDomain(t: TenantRecord, raw: string): TenantRecord {
  const domain = normalizeDomain(raw);
  if (domain === undefined) {
    throw new TenantDomainError(`not a domain this can revoke: ${JSON.stringify(raw)}`);
  }
  const current = t.domains ?? [];
  if (!current.includes(domain)) return t;
  return { ...t, domains: current.filter((d) => d !== domain) };
}

/** Move a tenant between permission tiers. */
export function setPolicy(t: TenantRecord, policy: TenantPolicy): TenantRecord {
  return { ...t, policy };
}

/** The tier a record actually runs at. */
export function policyOf(t: TenantRecord): TenantPolicy {
  return t.policy ?? DEFAULT_TENANT_POLICY;
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
