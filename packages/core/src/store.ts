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
   *  result bounds only what it *reads* — never what the store retrieves, sorts
   *  or holds. This is the bounded form: implementations MUST apply both the
   *  order and the window at the source (SQL `ORDER BY … LIMIT … OFFSET`).
   *
   *  Order is `compareSessionsNewestFirst`. `total` counts every session, not
   *  the page — it is what a caller needs in order to know a next page exists,
   *  and it comes from the same call so the two cannot disagree. */
  sessionsPage(opts: {
    limit?: number;
    offset?: number;
  }): Promise<{ sessions: Session[]; total: number }>;
  /** EVERY session, unbounded and unordered. The thread-list UI no longer uses
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
 *  Exported so the SQL store's ordering can be checked against this one rather
 *  than against a third re-implementation written by the test. */
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
