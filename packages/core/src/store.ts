import type { Session, Turn, Workspace } from "./types";

/** Persistence seam. Async so a real DB (Drizzle/Postgres) can back it.
 *  Phase 1 used a synchronous in-memory map; Phase 2 makes the contract async
 *  and adds a durable Drizzle implementation (`@genesis/db`). */
export interface Store {
  getWorkspace(id: string): Promise<Workspace | undefined>;
  upsertWorkspace(ws: Workspace): Promise<Workspace>;
  findSessionByThread(threadId: string): Promise<Session | undefined>;
  upsertSession(s: Session): Promise<Session>;
  addTurn(t: Omit<Turn, "id" | "createdAt">): Promise<Turn>;
  turnsForSession(sessionId: string): Promise<Turn[]>;
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
  async addTurn(t: Omit<Turn, "id" | "createdAt">) {
    const turn: Turn = { ...t, id: id("turn"), createdAt: now() };
    this.turns.push(turn);
    return turn;
  }
  async turnsForSession(sessionId: string) {
    return this.turns.filter((t) => t.sessionId === sessionId);
  }
}

export const newId = id;
export const isoNow = now;
