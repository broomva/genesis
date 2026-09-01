import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Store, Supervisor } from "@genesis/core";
import type { RunResult } from "@genesis/runner";
import { createPgliteStore } from "./factory";

const ws = { id: "ws-1", name: "test", rootPath: "/tmp/x" };

function fakeRunner(
  reply: string,
  sessionId: string,
): (o: { resumeSessionId?: string }) => Promise<RunResult> {
  return async () => ({
    state: { phase: "done" as const, sessionId, lastText: reply, turns: 1 },
    events: [],
    exitCode: 0,
  });
}

describe("DrizzleStore (pglite) — Store contract", () => {
  test("workspace upsert + read", async () => {
    const store = await createPgliteStore();
    await store.upsertWorkspace(ws);
    expect((await store.getWorkspace("ws-1"))?.name).toBe("test");
    await store.upsertWorkspace({ ...ws, name: "renamed" });
    expect((await store.getWorkspace("ws-1"))?.name).toBe("renamed");
    await store.close();
  });

  test("BRO-2236 — `confined` survives the round trip, in BOTH polarities", async () => {
    // The defect this covers: the workspaces table had three columns and the upsert
    // was projected to those three, so `confined` was dropped on every write. A
    // workspace read back from the DB then arrived with confined: undefined,
    // hardenedExtraArgs short-circuited, and the tenant ran with the operator's MCP
    // servers attached. Nothing failed loudly — that is why it survived.
    //
    // Mutation-proven: removing `confined` from the store projection makes this red.
    // Without it the projection could silently regress and 818 other tests stay green.
    const store = await createPgliteStore();

    await store.upsertWorkspace({ ...ws, id: "ws-confined", confined: true });
    expect((await store.getWorkspace("ws-confined"))?.confined).toBe(true);

    // NEGATIVE POLARITY — false must persist as false, not collapse to null and read
    // back as "never stated". A single-polarity assertion would pass on a store that
    // hardcoded true.
    await store.upsertWorkspace({ ...ws, id: "ws-open", confined: false });
    expect((await store.getWorkspace("ws-open"))?.confined).toBe(false);

    // AND an UPDATE must carry it too: the onConflictDoUpdate set is a second,
    // separately-projected code path, and a fix applied at one site only is the
    // recurring shape here.
    await store.upsertWorkspace({ ...ws, id: "ws-confined", confined: false });
    expect((await store.getWorkspace("ws-confined"))?.confined).toBe(false);

    await store.close();
  });

  test("session find-by-thread + agentSessionId null↔undefined round-trip", async () => {
    const store = await createPgliteStore();
    await store.upsertWorkspace(ws);
    await store.upsertSession({
      id: "s1",
      workspaceId: "ws-1",
      threadId: "t-1",
      phase: "idle",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const got = await store.findSessionByThread("t-1");
    if (!got) throw new Error("session not found");
    expect(got.id).toBe("s1");
    expect(got.agentSessionId).toBeUndefined(); // stored null → read undefined
    await store.upsertSession({ ...got, agentSessionId: "sid-9", phase: "done" });
    const updated = await store.findSessionByThread("t-1");
    expect(updated?.agentSessionId).toBe("sid-9");
    expect(updated?.phase).toBe("done");
    await store.close();
  });

  test("turns are returned in chronological order", async () => {
    const store = await createPgliteStore();
    const a = await store.addTurn({ sessionId: "s1", role: "user", text: "first" });
    const b = await store.addTurn({ sessionId: "s1", role: "agent", text: "second" });
    const list = await store.turnsForSession("s1");
    expect(list.map((t) => t.text)).toEqual(["first", "second"]);
    expect(list.map((t) => t.id)).toEqual([a.id, b.id]);
    await store.close();
  });

  test("findSessionsByPhase filters by phase (BRO-1530)", async () => {
    const store = await createPgliteStore();
    await store.upsertWorkspace(ws);
    const isoTs = "2026-01-01T00:00:00Z";
    const mk = (id: string, threadId: string, phase: "running" | "done" | "idle") =>
      store.upsertSession({ id, workspaceId: "ws-1", threadId, phase, createdAt: isoTs });
    await mk("r1", "t-r1", "running");
    await mk("r2", "t-r2", "running");
    await mk("d1", "t-d1", "done");
    expect((await store.findSessionsByPhase(["running"])).map((s) => s.id).sort()).toEqual([
      "r1",
      "r2",
    ]);
    expect(await store.findSessionsByPhase([])).toHaveLength(0);
    await store.close();
  });

  test("listSessions returns every session ordered by createdAt (BRO-1567)", async () => {
    const store = await createPgliteStore();
    await store.upsertWorkspace(ws);
    const mk = (id: string, threadId: string, createdAt: string) =>
      store.upsertSession({ id, workspaceId: "ws-1", threadId, phase: "idle", createdAt });
    await mk("b", "t-b", "2026-02-01T00:00:00.000Z");
    await mk("a", "t-a", "2026-01-01T00:00:00.000Z");
    await mk("c", "t-c", "2026-03-01T00:00:00.000Z");
    const all = await store.listSessions();
    expect(all.map((s) => s.id)).toEqual(["a", "b", "c"]); // createdAt-ascending
    await store.close();
  });
});

describe("DrizzleStore (pglite) — FS-as-truth continuity", () => {
  // EXPLICIT TIMEOUT, and the only two tests in this repo that need one.
  // Both open PGlite TWICE (write, close, reopen, read back) — that is the
  // property under test, so the cost is not incidental. Single-instance pglite
  // tests in this file run ~460ms; these two measured 12.7s and 7.6s on a loaded
  // CI runner and tripped bun's 5000ms default, reddening a required check on a
  // commit that touches no store code (genesis run 33475904352).
  //
  // 20s is chosen to sit far above the observed worst case and far below a real
  // hang: a deadlocked reopen still fails, it just fails honestly instead of
  // being indistinguishable from a slow one.
  test("a session + turns survive a close/reopen on the same data dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "genesis-db-"));
    const s1 = await createPgliteStore(dir);
    await s1.upsertWorkspace(ws);
    await s1.upsertSession({
      id: "sX",
      workspaceId: "ws-1",
      threadId: "thread-persist",
      agentSessionId: "claude-sid",
      phase: "done",
      createdAt: "2026-01-01T00:00:00Z",
    });
    await s1.addTurn({ sessionId: "sX", role: "user", text: "remember me" });
    await s1.close();

    const s2 = await createPgliteStore(dir); // reopen — fresh process-equivalent
    const got = await s2.findSessionByThread("thread-persist");
    expect(got?.agentSessionId).toBe("claude-sid"); // continuity recovered
    expect((await s2.turnsForSession("sX")).map((t) => t.text)).toEqual(["remember me"]);
    await s2.close();
  }, 20_000);
});

describe("Supervisor + DrizzleStore — sessions become selves", () => {
  test("resume continuity survives a Supervisor restart (durable agentSessionId)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "genesis-sup-"));
    const store1 = await createPgliteStore(dir);
    const sup1 = new Supervisor({
      defaultWorkspace: ws,
      store: store1,
      workspaceExists: () => true, // fake ws rootPath — bypass the RC3 vanished-cwd guard
      run: fakeRunner("hello", "claude-sess-1"),
    });
    await sup1.dispatch("chat-42", "first message");
    expect((await sup1.history("chat-42")).map((t) => t.role)).toEqual(["user", "agent"]);
    await store1.close();

    // brand-new Supervisor + store on the same dir — a process restart
    const store2 = await createPgliteStore(dir);
    let resumedWith: string | undefined = "unset";
    const sup2 = new Supervisor({
      defaultWorkspace: ws,
      store: store2,
      workspaceExists: () => true, // fake ws rootPath — bypass the RC3 vanished-cwd guard
      run: async (o) => {
        resumedWith = o.resumeSessionId;
        return {
          state: { phase: "done", sessionId: "claude-sess-1", lastText: "again", turns: 1 },
          events: [],
          exitCode: 0,
        };
      },
    });
    await sup2.dispatch("chat-42", "second message");
    expect(resumedWith).toBe("claude-sess-1"); // the self persisted across restart
    expect((await sup2.history("chat-42")).map((t) => t.text)).toEqual([
      "first message",
      "hello",
      "second message",
      "again",
    ]);
    await store2.close();
  }, 20_000);
});

describe("DrizzleStore (pglite) — deterministic ordering (P20 #4)", () => {
  test("turns stamped in the same millisecond preserve insertion order via seq", async () => {
    const store = await createPgliteStore();
    const inserted: string[] = [];
    for (let i = 0; i < 8; i++) {
      const t = await store.addTurn({
        sessionId: "sQ",
        role: i % 2 ? "agent" : "user",
        text: `m${i}`,
      });
      inserted.push(t.text);
    }
    const got = (await store.turnsForSession("sQ")).map((t) => t.text);
    expect(got).toEqual(inserted); // monotonic seq, not millisecond-collision-dependent
    await store.close();
  });
});

describe("DrizzleStore (pglite) — session management (BRO-1592)", () => {
  const base = { workspaceId: "ws-1", phase: "idle" as const, createdAt: "2026-01-01T00:00:00Z" };

  test("archived + title round-trip through upsertSession (set-clause fix)", async () => {
    const store = await createPgliteStore();
    await store.upsertWorkspace(ws);
    await store.upsertSession({ id: "sA", threadId: "t-a", ...base });
    // Defaults on a fresh row.
    let got = await store.findSessionByThread("t-a");
    expect(got?.archived).toBe(false);
    expect(got?.title).toBeUndefined();
    // Update must persist archived + title — the regression the set-clause fix guards.
    await store.upsertSession({
      id: "sA",
      threadId: "t-a",
      ...base,
      archived: true,
      title: "My thread",
    });
    got = await store.findSessionByThread("t-a");
    expect(got?.archived).toBe(true);
    expect(got?.title).toBe("My thread");
    await store.close();
  });

  test("noWorktree round-trips through upsertSession — insert + update (BRO-1656)", async () => {
    const store = await createPgliteStore();
    await store.upsertWorkspace(ws);
    // Fresh row: no per-session choice → undefined (inherit the default).
    await store.upsertSession({ id: "sW", threadId: "t-w", ...base });
    let got = await store.findSessionByThread("t-w");
    expect(got?.noWorktree).toBeUndefined();
    // Bind a per-session choice (root) — must persist through the set-clause on update.
    await store.upsertSession({ id: "sW", threadId: "t-w", ...base, noWorktree: true });
    got = await store.findSessionByThread("t-w");
    expect(got?.noWorktree).toBe(true);
    // And the other posture (worktree) round-trips as false, not lost as falsy.
    await store.upsertSession({ id: "sW", threadId: "t-w", ...base, noWorktree: false });
    got = await store.findSessionByThread("t-w");
    expect(got?.noWorktree).toBe(false);
    await store.close();
  });

  test("branch round-trips through upsertSession — insert + update (BRO-1664)", async () => {
    const store = await createPgliteStore();
    await store.upsertWorkspace(ws);
    await store.upsertSession({ id: "sB", threadId: "t-b", ...base });
    let got = await store.findSessionByThread("t-b");
    expect(got?.branch).toBeUndefined();
    await store.upsertSession({ id: "sB", threadId: "t-b", ...base, branch: "main" });
    got = await store.findSessionByThread("t-b");
    expect(got?.branch).toBe("main");
    // A branch change (user switched branches) must persist through the set-clause.
    await store.upsertSession({ id: "sB", threadId: "t-b", ...base, branch: "feat/x" });
    got = await store.findSessionByThread("t-b");
    expect(got?.branch).toBe("feat/x");
    await store.close();
  });

  test("updateSessionTitle is atomic + title-only + guarded (BRO-1665)", async () => {
    const store = await createPgliteStore();
    await store.upsertWorkspace(ws);
    // A ran session with a heuristic title + a live agentSessionId + phase.
    await store.upsertSession({
      id: "sT",
      threadId: "t-t",
      ...base,
      phase: "done",
      title: "Write a 1500 word",
      agentSessionId: "sid-live",
      branch: "main",
    });
    // Matching guard → upgrades, and touches ONLY the title (other fields intact).
    expect(await store.updateSessionTitle("sT", "Consensus Comparison", "Write a 1500 word")).toBe(
      true,
    );
    let got = await store.findSessionByThread("t-t");
    expect(got?.title).toBe("Consensus Comparison");
    expect(got?.agentSessionId).toBe("sid-live"); // NOT clobbered
    expect(got?.branch).toBe("main"); // NOT clobbered
    expect(got?.phase).toBe("done"); // NOT clobbered
    // Stale guard (the title already changed / a rename) → no-op, returns false.
    expect(await store.updateSessionTitle("sT", "Should Not Win", "Write a 1500 word")).toBe(false);
    got = await store.findSessionByThread("t-t");
    expect(got?.title).toBe("Consensus Comparison");
    // A missing session → false, no throw.
    expect(await store.updateSessionTitle("nope", "x", undefined)).toBe(false);
    // NULL-title guard (never-titled thread) matches `undefined`.
    await store.upsertSession({ id: "sN", threadId: "t-n", ...base });
    expect(await store.updateSessionTitle("sN", "First Title", undefined)).toBe(true);
    expect((await store.findSessionByThread("t-n"))?.title).toBe("First Title");
    await store.close();
  });

  test("listSessions includes archived rows (drawer filters, not the store)", async () => {
    const store = await createPgliteStore();
    await store.upsertWorkspace(ws);
    await store.upsertSession({ id: "s1", threadId: "t-1", ...base, archived: true });
    await store.upsertSession({ id: "s2", threadId: "t-2", ...base });
    expect((await store.listSessions()).map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    await store.close();
  });

  test("deleteSession removes the session AND its turns (no orphans)", async () => {
    const store = await createPgliteStore();
    await store.upsertWorkspace(ws);
    await store.upsertSession({ id: "sDel", threadId: "t-del", ...base });
    await store.addTurn({ sessionId: "sDel", role: "user", text: "bye" });
    await store.addTurn({ sessionId: "sDel", role: "agent", text: "ok" });
    expect(await store.turnsForSession("sDel")).toHaveLength(2);
    await store.deleteSession("sDel");
    expect(await store.findSessionByThread("t-del")).toBeUndefined();
    expect(await store.turnsForSession("sDel")).toHaveLength(0);
    await store.close();
  });
});

describe("DrizzleStore (pglite) — turn usage (BRO-1597)", () => {
  test("usage + cost round-trip through the dedicated columns", async () => {
    const store = await createPgliteStore();
    await store.addTurn({
      sessionId: "sU",
      role: "agent",
      text: "hi",
      usage: { input: 1200, output: 80, cacheRead: 300, cacheCreation: 50 },
      costUsd: 0.0042,
    });
    const [t] = await store.turnsForSession("sU");
    expect(t?.usage).toEqual({ input: 1200, output: 80, cacheRead: 300, cacheCreation: 50 });
    expect(t?.costUsd).toBeCloseTo(0.0042);
    await store.close();
  });

  test("a turn with no usage reads back undefined (not zeroes)", async () => {
    const store = await createPgliteStore();
    await store.addTurn({ sessionId: "sN", role: "user", text: "hi" });
    const [t] = await store.turnsForSession("sN");
    expect(t?.usage).toBeUndefined();
    expect(t?.costUsd).toBeUndefined();
    await store.close();
  });
});

describe("DrizzleStore (pglite) — turn parts + thinking (BRO-1607)", () => {
  test("the ordered text+tool timeline round-trips so a reload rebuilds tools", async () => {
    const store = await createPgliteStore();
    const parts = [
      { type: "text" as const, text: "Let me check." },
      {
        type: "tool" as const,
        toolCallId: "tu1",
        toolName: "Bash",
        input: { command: "ls" },
        output: "README.md",
        state: "output-available" as const,
      },
      { type: "text" as const, text: "Found it." },
    ];
    await store.addTurn({
      sessionId: "sP",
      role: "agent",
      text: "Found it.",
      parts,
      thinkingTokens: 150,
      reasoned: true,
    });
    const [t] = await store.turnsForSession("sP");
    expect(t?.parts).toEqual(parts); // exact ordered timeline survives the reload
    expect(t?.thinkingTokens).toBe(150);
    expect(t?.reasoned).toBe(true);
    await store.close();
  });

  test("reasoned round-trips with NO token estimate (effort-high indicator survives reload, BRO-1608)", async () => {
    const store = await createPgliteStore();
    await store.addTurn({ sessionId: "sR", role: "agent", text: "ok", reasoned: true });
    const [t] = await store.turnsForSession("sR");
    expect(t?.reasoned).toBe(true);
    expect(t?.thinkingTokens).toBeUndefined(); // no count, but the indicator still shows
    expect(t?.reasoning).toBeUndefined(); // no prose under subscription auth
    await store.close();
  });

  test("verbatim reasoning prose round-trips (so a non-redacting deployment reloads real reasoning, BRO-1608)", async () => {
    const store = await createPgliteStore();
    await store.addTurn({
      sessionId: "sV",
      role: "agent",
      text: "ok",
      reasoned: true,
      reasoning: "First I considered X, then Y.",
    });
    const [t] = await store.turnsForSession("sV");
    expect(t?.reasoning).toBe("First I considered X, then Y.");
    // empty prose stores as null → reads back undefined (indicator fallback)
    await store.addTurn({
      sessionId: "sV2",
      role: "agent",
      text: "ok",
      reasoned: true,
      reasoning: "",
    });
    const [t2] = await store.turnsForSession("sV2");
    expect(t2?.reasoning).toBeUndefined();
    await store.close();
  });

  test("a turn with no parts reads back undefined (pre-1607 history → text fallback)", async () => {
    const store = await createPgliteStore();
    await store.addTurn({ sessionId: "sQ", role: "agent", text: "plain" });
    const [t] = await store.turnsForSession("sQ");
    expect(t?.parts).toBeUndefined();
    expect(t?.thinkingTokens).toBeUndefined();
    expect(t?.reasoned).toBeUndefined();
    expect(t?.durationMs).toBeUndefined();
    await store.close();
  });

  test("run time (durationMs) round-trips so a reloaded turn shows '5m 24s' (BRO-1610)", async () => {
    const store = await createPgliteStore();
    await store.addTurn({ sessionId: "sD", role: "agent", text: "done", durationMs: 324_000 });
    const [t] = await store.turnsForSession("sD");
    expect(t?.durationMs).toBe(324_000);
    await store.close();
  });
});

describe("DrizzleStore (pglite) — sessionsPage is bounded AT THE SOURCE (follow-up to BRO-2418)", () => {
  // Building the client here rather than through `createPgliteStore` is the
  // point: the factory hides it, and the only way to show the LIMIT reached
  // Postgres is to watch what Postgres was asked and what it handed back.
  const instrumented = async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { MIGRATE_SQL } = await import("./schema");
    const { DrizzleStore } = await import("./store");
    const client = new PGlite();
    await client.exec(MIGRATE_SQL);
    const seen: Array<{ sql: string; rows: number }> = [];
    const origQuery = client.query.bind(client);
    // Forward EVERY argument. The first draft of this wrapper took (sql, params)
    // and dropped drizzle's third argument — the row-mode/parser options — so
    // `count(*)` came back in a shape the store read as NaN. The instrument was
    // corrupting the thing it measured, and it failed loudly only because the
    // assertion happened to cover the count; a wrapper that merely perturbed
    // ORDERING would have been invisible.
    (client as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query = async (
      ...args: unknown[]
    ) => {
      const r = (await (origQuery as (...a: unknown[]) => Promise<unknown>)(...args)) as {
        rows?: unknown[];
      };
      seen.push({ sql: String(args[0] ?? ""), rows: r.rows?.length ?? 0 });
      return r;
    };
    const store = new DrizzleStore(drizzle(client), () => client.close());
    return { store, seen };
  };

  const seed = async (store: Store, rows: Array<{ id: string; createdAt: string }>) => {
    await store.upsertWorkspace(ws);
    for (const r of rows) {
      await store.upsertSession({
        id: r.id,
        workspaceId: ws.id,
        threadId: `t-${r.id}`,
        phase: "idle",
        createdAt: r.createdAt,
      });
    }
  };

  test("no query retrieves more rows than the window", async () => {
    // The property, not a spelling of it. Asserting the SQL string contains
    // "limit" would pass for a query that also selected everything else; this
    // fails for ANY implementation that hydrates rows outside the page —
    // including `listSessions()`-then-slice, which returns an identical page.
    const { store, seen } = await instrumented();
    await seed(
      store,
      Array.from({ length: 250 }, (_, i) => ({
        id: `sess-${String(i).padStart(3, "0")}`,
        createdAt: new Date(Date.UTC(2026, 7, 31, 12, 0, 0) - i * 1000).toISOString(),
      })),
    );
    seen.length = 0;

    const page = await store.sessionsPage({ limit: 5 });
    expect(page.sessions.length).toBe(5);
    expect(page.total).toBe(250); // the total is exact despite the bound

    const widest = Math.max(...seen.map((q) => q.rows));
    expect(widest).toBeLessThanOrEqual(5);
    await store.close();
  });

  test('the ORDER BY pins COLLATE "C" — the cross-store agreement is by construction', async () => {
    // The conformance suite below compares this store against InMemoryStore and
    // passes — but PGlite reports datcollate `C`, so it would pass for an
    // unpinned ORDER BY too. It cannot discriminate the property, and production
    // is a Postgres created with a locale collation.
    //
    // Since the divergent engine is not reachable from this suite, the claim is
    // bound to the mechanism that makes the engine irrelevant: the emitted SQL.
    // This is a weaker check than a behavioural one and is written down as such
    // — it fails if someone drops the collation, which is the regression.
    const { store, seen } = await instrumented();
    await seed(store, [{ id: "s-1", createdAt: "2026-08-31T12:00:00.000Z" }]);
    seen.length = 0;
    await store.sessionsPage({ limit: 1 });
    const ordering = seen.filter((q) => /order\s+by/i.test(q.sql));
    expect(ordering.length).toBeGreaterThan(0);
    for (const q of ordering) expect(q.sql).toContain('COLLATE "C"');
    await store.close();
  });

  test("an unbounded page still returns everything", async () => {
    // The bound must not become a silent cap: no `limit` means every session,
    // which is what existing callers expect.
    const { store } = await instrumented();
    await seed(
      store,
      Array.from({ length: 30 }, (_, i) => ({
        id: `sess-${String(i).padStart(3, "0")}`,
        createdAt: new Date(Date.UTC(2026, 7, 31, 12, 0, 0) - i * 1000).toISOString(),
      })),
    );
    const all = await store.sessionsPage({});
    expect(all.sessions.length).toBe(30);
    expect(all.total).toBe(30);
    await store.close();
  });
});

describe("sessionsPage — the two Store implementations agree (follow-up to BRO-2418)", () => {
  // Ordering moved INTO the query, so the order is now decided by Postgres for
  // one implementation and by JS for the other. Nothing makes those agree by
  // construction: `created_at` and `id` are `text`, so SQL ordering runs under
  // the database collation while `InMemoryStore` uses JS string compare. Two
  // implementations of one paging contract that sort differently is how a row
  // lands on two pages, or none.
  //
  // So this checks them against EACH OTHER rather than against a comparator the
  // test re-implements — a mirror of the code under test would agree with a
  // wrong implementation just as happily.
  const corpus = [
    // Tied timestamps, ids deliberately NOT in insertion order, so the `id`
    // tiebreaker is what decides and insertion order cannot fake agreement.
    { id: "s-b", createdAt: "2026-08-31T12:00:00.000Z" },
    { id: "s-A", createdAt: "2026-08-31T12:00:00.000Z" },
    { id: "s_1", createdAt: "2026-08-31T12:00:00.000Z" },
    { id: "s-a", createdAt: "2026-08-31T12:00:00.000Z" },
    { id: "s-1", createdAt: "2026-08-31T12:00:00.000Z" },
    // Distinct, interleaved.
    { id: "s-z", createdAt: "2026-08-31T13:00:00.000Z" },
    { id: "s-c", createdAt: "2026-08-31T11:00:00.000Z" },
    { id: "s-d", createdAt: "2026-08-31T13:00:00.000Z" },
  ];

  const fill = async (store: Store) => {
    await store.upsertWorkspace(ws);
    for (const r of corpus) {
      await store.upsertSession({
        id: r.id,
        workspaceId: ws.id,
        threadId: `t-${r.id}`,
        phase: "idle",
        createdAt: r.createdAt,
      });
    }
  };

  test("identical order, and identical pages at every boundary", async () => {
    const { InMemoryStore } = await import("@genesis/core");
    const mem = new InMemoryStore();
    const pg = await createPgliteStore();
    await fill(mem);
    await fill(pg);

    const ids = (r: { sessions: Array<{ id: string }> }) => r.sessions.map((s) => s.id);
    const memAll = ids(await mem.sessionsPage({}));
    const pgAll = ids(await pg.sessionsPage({}));
    expect(pgAll).toEqual(memAll);
    expect(memAll.length).toBe(corpus.length);

    // Every window, not just one: a divergence at a single boundary is exactly
    // the failure mode, and one sampled page would miss it.
    for (let limit = 1; limit <= corpus.length; limit++) {
      for (let offset = 0; offset <= corpus.length; offset++) {
        expect(ids(await pg.sessionsPage({ limit, offset }))).toEqual(
          ids(await mem.sessionsPage({ limit, offset })),
        );
      }
    }
    await pg.close();
  });

  test("paging the whole corpus yields each row exactly once", async () => {
    // The property the tiebreaker exists for. Without a total order, tied rows
    // can shift between the two queries that make up two pages, so a row is
    // served twice or skipped — and the response looks well-formed either way.
    const pg = await createPgliteStore();
    await fill(pg);
    const seen: string[] = [];
    for (let offset = 0; offset < corpus.length; offset += 3) {
      seen.push(...(await pg.sessionsPage({ limit: 3, offset })).sessions.map((s) => s.id));
    }
    expect(seen.length).toBe(corpus.length);
    expect(new Set(seen).size).toBe(corpus.length);
    expect([...seen].sort()).toEqual(corpus.map((c) => c.id).sort());
    await pg.close();
  });
});
