// DrizzleStore — the durable Store implementation. Driver-agnostic: it takes a
// drizzle db handle, so the same code backs pglite (tests / local FS-as-truth)
// and postgres-js (Railway Postgres in prod).

import { type Session, type Store, type Turn, type Workspace, isoNow, newId } from "@genesis/core";
import { eq, inArray } from "drizzle-orm";
import { sessions, turns, workspaces } from "./schema";

// drizzle db type varies by driver (pglite vs postgres-js); kept loose on purpose.
type DrizzleDb = any;

interface SessionRow {
  id: string;
  workspaceId: string;
  threadId: string;
  agentSessionId: string | null;
  phase: string;
  createdAt: string;
}

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    threadId: r.threadId,
    agentSessionId: r.agentSessionId ?? undefined,
    phase: r.phase as Session["phase"],
    createdAt: r.createdAt,
  };
}

export class DrizzleStore implements Store {
  constructor(
    private readonly db: DrizzleDb,
    private readonly closer?: () => Promise<void>,
  ) {}

  async getWorkspace(id: string): Promise<Workspace | undefined> {
    const r = await this.db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    return r[0];
  }

  async upsertWorkspace(ws: Workspace): Promise<Workspace> {
    await this.db
      .insert(workspaces)
      .values(ws)
      .onConflictDoUpdate({ target: workspaces.id, set: { name: ws.name, rootPath: ws.rootPath } });
    return ws;
  }

  async findSessionByThread(threadId: string): Promise<Session | undefined> {
    const r = await this.db.select().from(sessions).where(eq(sessions.threadId, threadId)).limit(1);
    return r[0] ? toSession(r[0]) : undefined;
  }

  async findSessionsByPhase(phases: readonly Session["phase"][]): Promise<Session[]> {
    if (phases.length === 0) return [];
    const r = await this.db
      .select()
      .from(sessions)
      .where(inArray(sessions.phase, phases as string[]));
    return r.map(toSession);
  }

  async upsertSession(s: Session): Promise<Session> {
    const row = {
      id: s.id,
      workspaceId: s.workspaceId,
      threadId: s.threadId,
      agentSessionId: s.agentSessionId ?? null,
      phase: s.phase,
      createdAt: s.createdAt,
    };
    await this.db
      .insert(sessions)
      .values(row)
      .onConflictDoUpdate({
        target: sessions.id,
        set: { agentSessionId: row.agentSessionId, phase: row.phase, workspaceId: row.workspaceId },
      });
    return s;
  }

  async addTurn(t: Omit<Turn, "id" | "createdAt">): Promise<Turn> {
    const turn: Turn = { ...t, id: newId("turn"), createdAt: isoNow() };
    await this.db.insert(turns).values(turn);
    return turn;
  }

  async turnsForSession(sessionId: string): Promise<Turn[]> {
    const r = await this.db
      .select()
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(turns.seq); // DB-assigned monotonic order (P20 #4)
    return r.map((x: Turn) => ({
      id: x.id,
      sessionId: x.sessionId,
      role: x.role,
      text: x.text,
      createdAt: x.createdAt,
    }));
  }

  /** Release the underlying driver (tests reopen the same data dir). */
  async close(): Promise<void> {
    await this.closer?.();
  }
}
