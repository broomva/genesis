import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor } from "@genesis/core";
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
  });
});

describe("Supervisor + DrizzleStore — sessions become selves", () => {
  test("resume continuity survives a Supervisor restart (durable agentSessionId)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "genesis-sup-"));
    const store1 = await createPgliteStore(dir);
    const sup1 = new Supervisor({
      defaultWorkspace: ws,
      store: store1,
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
  });
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
