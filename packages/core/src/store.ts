import type { Session, Turn, Workspace } from "./types";

/** Persistence seam. Async so a real DB (Drizzle/Postgres) can back it.
 *  Phase 1 used a synchronous in-memory map; Phase 2 makes the contract async
 *  and adds a durable Drizzle implementation (`@genesis/db`). */
export interface Store {
  getWorkspace(id: string): Promise<Workspace | undefined>;
  upsertWorkspace(ws: Workspace): Promise<Workspace>;
  findSessionByThread(threadId: string): Promise<Session | undefined>;
  upsertSession(s: Session): Promise<Session>;
  /** Sessions whose stored phase is any of `phases`. Used for boot-time
   *  reconciliation of turns interrupted by a process crash (BRO-1530). */
  findSessionsByPhase(phases: readonly Session["phase"][]): Promise<Session[]>;
  /** Every session, for the thread-list UI (BRO-1567). Order is unspecified —
   *  callers (Supervisor.listThreads) sort for display. Includes archived
   *  sessions; the drawer filters them (BRO-1592). */
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
  async findSessionsByPhase(phases: readonly Session["phase"][]) {
    const want = new Set(phases);
    return [...this.sessions.values()].filter((s) => want.has(s.phase)).map((s) => ({ ...s }));
  }
  async listSessions() {
    return [...this.sessions.values()].map((s) => ({ ...s }));
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
