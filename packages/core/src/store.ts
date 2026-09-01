import type { Session, Turn, Workspace } from "./types";

/** Persistence seam. Async so a real DB (Drizzle/Postgres) can back it.
 *  Phase 1 used a synchronous in-memory map; Phase 2 makes the contract async
 *  and adds a durable Drizzle implementation (`@genesis/db`). */
export interface Store {
  getWorkspace(id: string): Promise<Workspace | undefined>;
  upsertWorkspace(ws: Workspace): Promise<Workspace>;
  findSessionByThread(threadId: string): Promise<Session | undefined>;
  upsertSession(s: Session): Promise<Session>;
  /** Atomically set a session's title ONLY if its current title still equals
   *  `ifTitleEquals` (BRO-1665). A scoped check-then-act update: it touches only the
   *  `title` column (so it can't clobber a concurrent turn's phase/agentSessionId/
   *  branch the way a whole-row upsert from a stale snapshot would) and won't
   *  overwrite a rename (the WHERE guard fails). Returns whether a row was updated. */
  updateSessionTitle(
    id: string,
    title: string,
    ifTitleEquals: string | undefined,
  ): Promise<boolean>;
  /** Sessions whose stored phase is any of `phases`. Used for boot-time
   *  reconciliation of turns interrupted by a process crash (BRO-1530). */
  findSessionsByPhase(phases: readonly Session["phase"][]): Promise<Session[]>;
  /** One ordered page of sessions plus the total, **from the source**.
   *
   *  `listSessions()` below materialises every row, so a caller that slices its
   *  result bounds only what it *reads*. A DURABLE implementation must apply the
   *  order and the window in the query, and must be backed by an index that can
   *  serve that exact order — without one the database still scans and sorts the
   *  whole table, and only the wire payload is bounded. `InMemoryStore` sorts
   *  its whole map and slices, which is the shape this paragraph warns about;
   *  that is acceptable there because the map IS the working set, and it is
   *  stated rather than left to be discovered.
   *
   *  Callers must satisfy `assertPageOpts`.
   *
   *  Order is `compareSessionsNewestFirst`. `total` counts every session, not
   *  the page — it is what a caller needs in order to know a next page exists,
   *  and it comes from the same call so the two cannot disagree. */
  sessionsPage(opts: {
    limit?: number;
    offset?: number;
  }): Promise<{ sessions: Session[]; total: number }>;
  /** EVERY session, unbounded. Order is unspecified BY CONTRACT — `DrizzleStore`
   *  happens to return them `ORDER BY created_at` and a test pins that, so do not
   *  read this as "arbitrary"; read it as "callers may not depend on it". The
   *  thread-list UI no longer uses
   *  this — it pages through `sessionsPage` — so the one remaining caller is the
   *  ask-log phase map in `apps/api/src/server.ts`, which needs every session
   *  because any ask may belong to any thread; bounding it there would silently
   *  age live asks. Prefer `sessionsPage` for anything user-facing. Includes
   *  archived sessions; the drawer filters them (BRO-1592). */
  listSessions(): Promise<Session[]>;
  addTurn(t: Omit<Turn, "id" | "createdAt">): Promise<Turn>;
  turnsForSession(sessionId: string): Promise<Turn[]>;
  /** Hard-delete a session and all its turns (BRO-1592). No FK cascade exists
   *  (session_id is plain text), so turns are removed first, then the session. */
  deleteSession(id: string): Promise<void>;
}

// Collision-safe across restarts, PIDs, and instances — required now that IDs
// are primary keys in durable storage (a counter+PID repeats after a restart).
const id = (p: string) => `${p}-${crypto.randomUUID()}`;
/** The total order `Store.sessionsPage` promises: newest-first by `createdAt`,
 *  ties broken by `id` ascending.
 *
 *  The tiebreaker is load-bearing, not cosmetic. `createdAt` is millisecond
 *  resolution, so two sessions created in the same millisecond tie — and paging
 *  over a non-unique sort key lets tied rows swap between queries, which makes
 *  the same row appear on two pages or on none. `id` is the primary key, so the
 *  pair is total and the boundary is stable.
 *
 *  Comparison is JS `<` on strings, i.e. UTF-16 code-unit order. The SQL store
 *  pins `COLLATE "C"`, i.e. UTF-8 byte order. Those coincide for ASCII and
 *  DIVERGE above U+FFFF, where a JS surrogate sorts below U+E000..U+FFFF but its
 *  UTF-8 bytes sort above. Unreachable today — ids are `sess-<uuid>` and
 *  `createdAt` is ISO, both ASCII — but the two are NOT the same order, and a
 *  future sort key drawn from user text would make the difference reachable.
 *
 *  Exported as the single definition of the order, so the SQL `ORDER BY` has a
 *  named referent to mirror rather than the two drifting independently. */
/** The precondition `Store.sessionsPage` puts on its window, enforced identically
 *  by every implementation.
 *
 *  It THROWS rather than clamping because the two implementations disagree on
 *  what invalid input means and both answers look plausible: `Array#slice`
 *  reads a negative offset as "from the end" and a `NaN` limit as "nothing",
 *  while Postgres rejects both outright. Measured on the same four sessions,
 *  `{limit: NaN}` returned [] in memory and ALL FOUR rows from pg — two
 *  successful calls, different answers, no error on either side. Clamping would
 *  have picked one of those meanings and hidden the caller's bug; throwing puts
 *  it at the boundary. No live caller is affected: the HTTP route sanitises
 *  before it gets here. */
export function assertPageOpts(opts: { limit?: number; offset?: number }): void {
  for (const [name, v] of [
    ["limit", opts.limit],
    ["offset", opts.offset],
  ] as const) {
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < 0) {
      throw new TypeError(
        `sessionsPage: ${name} must be a non-negative integer or undefined, got ${String(v)}`,
      );
    }
  }
}

export const compareSessionsNewestFirst = (a: Session, b: Session): number =>
  a.createdAt < b.createdAt
    ? 1
    : a.createdAt > b.createdAt
      ? -1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

const now = () => new Date(performance.timeOrigin + performance.now()).toISOString();

export class InMemoryStore implements Store {
  private workspaces = new Map<string, Workspace>();
  private sessions = new Map<string, Session>();
  private turns: Turn[] = [];

  async getWorkspace(wid: string) {
    return this.workspaces.get(wid);
  }
  async upsertWorkspace(ws: Workspace) {
    this.workspaces.set(ws.id, ws);
    return ws;
  }
  async findSessionByThread(threadId: string) {
    for (const s of this.sessions.values()) if (s.threadId === threadId) return s;
    return undefined;
  }
  async upsertSession(s: Session) {
    this.sessions.set(s.id, { ...s });
    return s;
  }
  async updateSessionTitle(sessionId: string, title: string, ifTitleEquals: string | undefined) {
    const s = this.sessions.get(sessionId);
    if (!s || s.title !== ifTitleEquals) return false; // gone, renamed, or already upgraded
    s.title = title;
    return true;
  }
  async findSessionsByPhase(phases: readonly Session["phase"][]) {
    const want = new Set(phases);
    return [...this.sessions.values()].filter((s) => want.has(s.phase)).map((s) => ({ ...s }));
  }
  async listSessions() {
    return [...this.sessions.values()].map((s) => ({ ...s }));
  }

  async sessionsPage(opts: { limit?: number; offset?: number }) {
    assertPageOpts(opts);
    const ordered = [...this.sessions.values()].sort(compareSessionsNewestFirst);
    const offset = opts.offset ?? 0;
    const page =
      opts.limit === undefined ? ordered.slice(offset) : ordered.slice(offset, offset + opts.limit);
    return { sessions: page.map((s) => ({ ...s })), total: ordered.length };
  }
  async addTurn(t: Omit<Turn, "id" | "createdAt">) {
    const turn: Turn = { ...t, id: id("turn"), createdAt: now() };
    this.turns.push(turn);
    return turn;
  }
  async turnsForSession(sessionId: string) {
    return this.turns.filter((t) => t.sessionId === sessionId);
  }
  async deleteSession(sessionId: string) {
    this.sessions.delete(sessionId);
    this.turns = this.turns.filter((t) => t.sessionId !== sessionId);
  }
}

export const newId = id;
export const isoNow = now;
