// DrizzleStore — the durable Store implementation. Driver-agnostic: it takes a
// drizzle db handle, so the same code backs pglite (tests / local FS-as-truth)
// and postgres-js (Railway Postgres in prod).

import {
  type Session,
  type Store,
  type Turn,
  type TurnPart,
  type Workspace,
  isoNow,
  newId,
} from "@genesis/core";
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
  archived?: boolean | null;
  title?: string | null;
}

interface TurnRow {
  id: string;
  sessionId: string;
  role: string;
  text: string;
  createdAt: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  costUsd?: number | null;
  parts?: string | null;
  thinkingTokens?: number | null;
}

/** Parse the JSON-encoded parts timeline (BRO-1607); tolerate malformed/legacy
 *  data by dropping it (the reload then falls back to the plain `text`). */
function parseParts(raw: string | null | undefined): TurnPart[] | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.length > 0 ? (v as TurnPart[]) : undefined;
  } catch {
    return undefined;
  }
}

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    threadId: r.threadId,
    agentSessionId: r.agentSessionId ?? undefined,
    phase: r.phase as Session["phase"],
    createdAt: r.createdAt,
    archived: r.archived ?? false,
    title: r.title ?? undefined,
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

  async listSessions(): Promise<Session[]> {
    const r = await this.db.select().from(sessions).orderBy(sessions.createdAt);
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
      archived: s.archived ?? false,
      title: s.title ?? null,
    };
    await this.db
      .insert(sessions)
      .values(row)
      .onConflictDoUpdate({
        target: sessions.id,
        // The set-clause must list EVERY mutable column — anything omitted is
        // silently dropped on update. archived/title (BRO-1592) join phase +
        // agentSessionId here, or an archive/rename write would no-op.
        set: {
          agentSessionId: row.agentSessionId,
          phase: row.phase,
          workspaceId: row.workspaceId,
          archived: row.archived,
          title: row.title,
        },
      });
    return s;
  }

  async deleteSession(id: string): Promise<void> {
    // No FK cascade (session_id is plain text) — remove turns then the session,
    // atomically in one transaction so a crash mid-delete can't leave a session
    // with 0 turns (or orphaned turns). pglite + postgres-js both support it.
    await this.db.transaction(async (tx: DrizzleDb) => {
      await tx.delete(turns).where(eq(turns.sessionId, id));
      await tx.delete(sessions).where(eq(sessions.id, id));
    });
  }

  async addTurn(t: Omit<Turn, "id" | "createdAt">): Promise<Turn> {
    const turn: Turn = { ...t, id: newId("turn"), createdAt: isoNow() };
    // Flatten usage (BRO-1597) into the dedicated columns — the nested object
    // doesn't map to columns automatically.
    await this.db.insert(turns).values({
      id: turn.id,
      sessionId: turn.sessionId,
      role: turn.role,
      text: turn.text,
      createdAt: turn.createdAt,
      inputTokens: turn.usage?.input ?? null,
      outputTokens: turn.usage?.output ?? null,
      cacheReadTokens: turn.usage?.cacheRead ?? null,
      cacheCreationTokens: turn.usage?.cacheCreation ?? null,
      costUsd: turn.costUsd ?? null,
      // Ordered timeline + thinking estimate (BRO-1607) — JSON for parts.
      parts: turn.parts && turn.parts.length > 0 ? JSON.stringify(turn.parts) : null,
      thinkingTokens: turn.thinkingTokens ?? null,
    });
    return turn;
  }

  async turnsForSession(sessionId: string): Promise<Turn[]> {
    const r = await this.db
      .select()
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(turns.seq); // DB-assigned monotonic order (P20 #4)
    return r.map((x: TurnRow) => {
      const hasUsage =
        x.inputTokens != null ||
        x.outputTokens != null ||
        x.cacheReadTokens != null ||
        x.cacheCreationTokens != null;
      return {
        id: x.id,
        sessionId: x.sessionId,
        role: x.role as Turn["role"],
        text: x.text,
        createdAt: x.createdAt,
        usage: hasUsage
          ? {
              input: x.inputTokens ?? 0,
              output: x.outputTokens ?? 0,
              cacheRead: x.cacheReadTokens ?? 0,
              cacheCreation: x.cacheCreationTokens ?? 0,
            }
          : undefined,
        costUsd: x.costUsd ?? undefined,
        parts: parseParts(x.parts),
        thinkingTokens: x.thinkingTokens ?? undefined,
      };
    });
  }

  /** Release the underlying driver (tests reopen the same data dir). */
  async close(): Promise<void> {
    await this.closer?.();
  }
}
