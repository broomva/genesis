// DrizzleStore — the durable Store implementation. Driver-agnostic: it takes a
// drizzle db handle, so the same code backs pglite (tests / local FS-as-truth)
// and postgres-js (Railway Postgres in prod).

import {
  type Session,
  type Store,
  type Turn,
  type TurnPart,
  type Workspace,
  assertPageOpts,
  isoNow,
  newId,
} from "@genesis/core";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
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
  engine?: string | null;
  noWorktree?: boolean | null;
  branch?: string | null;
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
  reasoned?: boolean | null;
  reasoning?: string | null;
  durationMs?: number | null;
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
    engine: r.engine ?? undefined,
    noWorktree: r.noWorktree ?? undefined,
    branch: r.branch ?? undefined,
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
    // Project to the DECLARED columns only (P20 N2): the Workspace type carries
    // registry-only fields (isGitRepo/noWorktree) that have no column — drizzle
    // drops them today, but an explicit projection keeps that intentional (a
    // future driver/added column can't silently start persisting them).
    await this.db
      .insert(workspaces)
      .values({ id: ws.id, name: ws.name, rootPath: ws.rootPath, confined: ws.confined ?? null })
      .onConflictDoUpdate({
        target: workspaces.id,
        set: { name: ws.name, rootPath: ws.rootPath, confined: ws.confined ?? null },
      });
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

  /** See `Store.sessionsPage`.
   *
   *  What is and is not bounded, measured with EXPLAIN (ANALYZE) on PGlite over
   *  20k sessions asking for a page of 10:
   *
   *    no index                          Seq Scan rows=20000, 217 buffers, 12.7 ms
   *    sessions_page_idx                 Index Scan rows=10,   13 buffers,  0.17 ms
   *    sessions_page_idx + count() over  Index Scan rows=20000, 20145 buffers, 25.6 ms
   *
   *  The PAGE is bounded — the scan node reports rows=10, so the database really
   *  does stop at the window. That depends entirely on `sessions_page_idx`, whose
   *  collation must match this ORDER BY exactly; an index declared without the
   *  same `COLLATE "C"` cannot serve it and the planner silently reverts to the
   *  first line.
   *
   *  The TOTAL is not bounded and cannot be: an exact count of a table costs a
   *  scan of it. That is the price of returning `total` at all.
   *
   *  An earlier revision carried the total on each page row via `count(*) over()`
   *  to get both from one statement. That is the third line above: a window
   *  function with an empty frame must drain its whole input before it emits a
   *  row, so it forced the very full retrieve-and-sort the method exists to
   *  avoid, and made the page 147x more expensive than the indexed form. It was
   *  removed. The single-snapshot property it bought is instead bought by a
   *  REPEATABLE READ transaction, which costs a round trip rather than a scan.
   *
   *  Why a transaction at all: the code this replaced read every session once, so
   *  its page and its total could not disagree. Two independent statements can —
   *  an insert landing between them yields a total that does not describe the
   *  page, and `hasMore` derived from it is wrong on a surface the client polls.
   *  REPEATABLE READ gives both statements one snapshot, restoring the property
   *  the single scan had for free.
   *
   *  `count()` is drizzle's, which carries `.mapWith(Number)`. That is
   *  load-bearing across drivers, not decoration: `count(*)` is `int8`, and
   *  postgres-js does not register a parser for OID 20, so on Railway it arrives
   *  as the STRING "250" while PGlite hands back a number. A hand-written
   *  `Number(...)` would be correct but exercised only on the engine where it is
   *  a no-op. */
  async sessionsPage(opts: {
    limit?: number;
    offset?: number;
  }): Promise<{ sessions: Session[]; total: number }> {
    assertPageOpts(opts);
    const offset = opts.offset ?? 0;
    return this.db.transaction(
      async (tx: DrizzleDb) => {
        const ordered = tx
          .select()
          .from(sessions)
          .orderBy(sql`${sessions.createdAt} COLLATE "C" DESC, ${sessions.id} COLLATE "C" ASC`);
        const rows =
          opts.limit === undefined
            ? await ordered.offset(offset)
            : await ordered.limit(opts.limit).offset(offset);
        const totals = await tx.select({ n: count() }).from(sessions);
        return { sessions: rows.map(toSession), total: totals[0]?.n ?? 0 };
      },
      { isolationLevel: "repeatable read" },
    );
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
      engine: s.engine ?? null,
      noWorktree: s.noWorktree ?? null,
      branch: s.branch ?? null,
    };
    await this.db
      .insert(sessions)
      .values(row)
      .onConflictDoUpdate({
        target: sessions.id,
        // The set-clause must list EVERY mutable column — anything omitted is
        // silently dropped on update. archived/title (BRO-1592) + engine (BRO-1620)
        // join phase + agentSessionId here, or their writes would no-op.
        set: {
          agentSessionId: row.agentSessionId,
          phase: row.phase,
          workspaceId: row.workspaceId,
          archived: row.archived,
          title: row.title,
          engine: row.engine,
          noWorktree: row.noWorktree,
          branch: row.branch,
        },
      });
    return s;
  }

  async updateSessionTitle(
    id: string,
    title: string,
    ifTitleEquals: string | undefined,
  ): Promise<boolean> {
    // Scoped, atomic check-then-act (BRO-1665): SET title WHERE id AND title matches
    // the expected current value. Touches only `title`, so it never clobbers a
    // concurrent turn's phase/agentSessionId/branch, and the WHERE guard makes the
    // "don't overwrite a rename" check race-free (a NULL title uses IS NULL).
    const rows = await this.db
      .update(sessions)
      .set({ title })
      .where(
        and(
          eq(sessions.id, id),
          ifTitleEquals === undefined ? isNull(sessions.title) : eq(sessions.title, ifTitleEquals),
        ),
      )
      .returning({ id: sessions.id });
    return rows.length > 0;
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
      // Did the model reason this turn (BRO-1608) — token-independent indicator.
      reasoned: turn.reasoned ?? null,
      // Verbatim prose when a deployment provides it (BRO-1608); "" → null.
      reasoning: turn.reasoning && turn.reasoning.length > 0 ? turn.reasoning : null,
      // Server-measured run time (BRO-1610).
      durationMs: turn.durationMs ?? null,
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
        reasoned: x.reasoned ?? undefined,
        reasoning: x.reasoning ?? undefined,
        durationMs: x.durationMs ?? undefined,
      };
    });
  }

  /** Release the underlying driver (tests reopen the same data dir). */
  async close(): Promise<void> {
    await this.closer?.();
  }
}
