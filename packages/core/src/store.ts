import type { Session, Turn, Workspace } from "./types";

/** Persistence seam. Phase 1 = in-memory; Phase 2 swaps in Postgres/Drizzle. */
export interface Store {
  getWorkspace(id: string): Workspace | undefined;
  upsertWorkspace(ws: Workspace): Workspace;
  findSessionByThread(threadId: string): Session | undefined;
  upsertSession(s: Session): Session;
  addTurn(t: Omit<Turn, "id" | "createdAt">): Turn;
  turnsForSession(sessionId: string): Turn[];
}

let counter = 0;
const id = (p: string) => `${p}-${(++counter).toString(36)}`;
const now = () => new Date(performance.timeOrigin + performance.now()).toISOString();

export class InMemoryStore implements Store {
  private workspaces = new Map<string, Workspace>();
  private sessions = new Map<string, Session>();
  private turns: Turn[] = [];

  getWorkspace(wid: string) {
    return this.workspaces.get(wid);
  }
  upsertWorkspace(ws: Workspace) {
    this.workspaces.set(ws.id, ws);
    return ws;
  }
  findSessionByThread(threadId: string) {
    for (const s of this.sessions.values()) if (s.threadId === threadId) return s;
    return undefined;
  }
  upsertSession(s: Session) {
    this.sessions.set(s.id, s);
    return s;
  }
  addTurn(t: Omit<Turn, "id" | "createdAt">) {
    const turn: Turn = { ...t, id: id("turn"), createdAt: now() };
    this.turns.push(turn);
    return turn;
  }
  turnsForSession(sessionId: string) {
    return this.turns.filter((t) => t.sessionId === sessionId);
  }
}

export const newId = id;
export const isoNow = now;
