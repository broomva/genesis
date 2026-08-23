// Durable tenant registry (BRO-2230) — one JSON record per tenant.
//
// Mirrors FsWorkspaceRepository's one-manifest-per-workspace convention rather
// than a single tenants.json: concurrent writers (the bot recording a request
// while the operator approves someone) touch different files, so neither can
// clobber the other's record. A single document would need a lock the bot does
// not have.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  MAX_TENANT_DOMAINS,
  TENANT_POLICIES,
  type TenantPolicy,
  type TenantRecord,
  type TenantState,
  normalizeDomain,
} from "./tenants";

const RECORD_RE = /\.json$/;

/** A tenant id is a filename component. Digits only — the registry key comes
 *  from `principalOf`, which normalizes to digits, so anything else is either a
 *  bug upstream or an attempt to escape the directory. Rejected, not sanitized:
 *  sanitizing turns a hostile id into a valid-looking neighbour's record. */
export function isSafeTenantId(id: string): boolean {
  return /^[0-9]{1,32}$/.test(id);
}

export class TenantStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(id: string): string {
    if (!isSafeTenantId(id)) throw new Error(`unsafe tenant id: ${JSON.stringify(id)}`);
    return join(this.dir, `${id}.json`);
  }

  get(id: string): TenantRecord | undefined {
    if (!isSafeTenantId(id)) return undefined; // a lookup must not throw on junk
    const p = join(this.dir, `${id}.json`);
    if (!existsSync(p)) return undefined;
    try {
      return parseRecord(JSON.parse(readFileSync(p, "utf8")));
    } catch {
      // A corrupt record must NOT read as "no such tenant": that would
      // re-acknowledge an approved person as a new requester, and worse, a
      // corrupt ACTIVE record would silently become unserved rather than loud.
      throw new Error(`tenant record ${id}.json is unreadable`);
    }
  }

  /** Write atomically — a torn record read by the bot mid-write is exactly the
   *  corrupt-record case above, and it would happen on every approval. */
  /** Stamp `lastSeenAt` WITHOUT carrying the rest of a stale snapshot back to disk.
   *
   *  The bot stamps this on every inbound message, from a record it read earlier in
   *  the same request. `put(decision.tenant)` therefore rewrote the WHOLE record --
   *  so an operator approval landing between that read and this write was silently
   *  reverted to `pending` by the next message the tenant sent. The write itself is
   *  atomic (tmp + rename), so this was never corruption; it was a lost update, which
   *  is quieter and worse.
   *
   *  Re-reads immediately before writing and changes exactly one field, so any state
   *  transition made concurrently survives. Not a substitute for locking under real
   *  contention -- it narrows the window to a single read-write and, more importantly,
   *  bounds the BLAST RADIUS to the field this caller actually owns. */
  touchLastSeen(id: string, now: string): void {
    const current = this.get(id);
    if (current === undefined) return; // nothing to stamp; do NOT resurrect a deleted record
    this.put({ ...current, lastSeenAt: now });
  }

  put(record: TenantRecord): void {
    const p = this.path(record.id);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, p);
  }

  list(): TenantRecord[] {
    if (!existsSync(this.dir)) return [];
    const out: TenantRecord[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!RECORD_RE.test(f)) continue;
      try {
        out.push(parseRecord(JSON.parse(readFileSync(join(this.dir, f), "utf8"))));
      } catch {
        // Skip unreadable records here (not in get()): `list` feeds the startup
        // check and the CLI, and one corrupt file must not make the whole
        // channel unstartable. get() is the path that must be loud.
        console.error(`[genesis-bot] skipping unreadable tenant record ${f}`);
      }
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** Tenants that should have a provisioned workspace. */
  active(): TenantRecord[] {
    return this.list().filter((t) => t.state === "active");
  }
}

const STATES: readonly TenantState[] = ["pending", "active", "suspended"];

/** Parse + validate. An unknown `state` is REJECTED rather than defaulted:
 *  defaulting to "pending" would silently demote an active tenant on a typo,
 *  and defaulting to "active" would promote a rejected one. */
export function parseRecord(raw: unknown): TenantRecord {
  if (typeof raw !== "object" || raw === null) throw new Error("record is not an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !isSafeTenantId(r.id)) throw new Error("bad id");
  if (r.channel !== "kapso") throw new Error("bad channel");
  if (typeof r.state !== "string" || !STATES.includes(r.state as TenantState))
    throw new Error(`bad state ${JSON.stringify(r.state)}`);
  if (typeof r.requestedAt !== "string") throw new Error("bad requestedAt");
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : undefined);

  // REJECT, never default. BRO-2236 was the opposite mistake one field over:
  // `confined` was absent from the parse, so the store projected it away and a
  // DB-resolved tenant came back UNCONFINED. A field that governs a boundary
  // must round-trip or make the record unreadable -- silently dropping it
  // widens access while every log line still says the record loaded fine.
  const rawPolicy = r.policy;
  if (rawPolicy !== undefined && !TENANT_POLICIES.includes(rawPolicy as TenantPolicy)) {
    throw new Error(`bad policy ${JSON.stringify(rawPolicy)}`);
  }
  const policy = rawPolicy as TenantPolicy | undefined;

  // Re-validate on READ, not only on write. The file is editable by hand and by
  // root, so the write path is not the only way a domain gets in here; a value
  // that would not survive `allowDomain` must not survive a load either.
  const rawDomains = r.domains;
  if (rawDomains !== undefined && !Array.isArray(rawDomains)) throw new Error("bad domains");
  const domains: string[] = [];
  for (const d of (rawDomains as unknown[]) ?? []) {
    if (typeof d !== "string") throw new Error("bad domain entry");
    const norm = normalizeDomain(d);
    if (norm === undefined) throw new Error(`bad domain ${JSON.stringify(d)}`);
    if (!domains.includes(norm)) domains.push(norm);
  }
  if (domains.length > MAX_TENANT_DOMAINS) throw new Error("too many domains");
  domains.sort();

  return {
    id: r.id,
    channel: "kapso",
    state: r.state as TenantState,
    ...(str("name") ? { name: str("name") } : {}),
    requestedAt: r.requestedAt,
    ...(str("acknowledgedAt") ? { acknowledgedAt: str("acknowledgedAt") } : {}),
    ...(str("approvedAt") ? { approvedAt: str("approvedAt") } : {}),
    ...(str("suspendedAt") ? { suspendedAt: str("suspendedAt") } : {}),
    ...(str("lastSeenAt") ? { lastSeenAt: str("lastSeenAt") } : {}),
    ...(str("note") ? { note: str("note") } : {}),
    ...(policy ? { policy } : {}),
    ...(domains.length > 0 ? { domains } : {}),
  };
}
