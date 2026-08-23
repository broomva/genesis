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
import type { TenantRecord, TenantState } from "./tenants";

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
  };
}
