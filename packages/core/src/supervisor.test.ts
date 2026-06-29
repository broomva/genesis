import { describe, expect, test } from "bun:test";
import type { RunResult } from "@genesis/runner";
import { InMemoryStore } from "./store";
import { Supervisor, deriveTitle } from "./supervisor";

const ws = { id: "ws-1", name: "test", rootPath: "/tmp/genesis-test" };

function fakeRunner(
  reply: string,
  sessionId = "s-1",
  phase: RunResult["state"]["phase"] = "done",
): (o: any) => Promise<RunResult> {
  return async (o) => {
    o.onState?.(
      { phase, sessionId, lastText: reply, turns: 1 },
      { type: "result", subtype: "success" },
    );
    return { state: { phase, sessionId, lastText: reply, turns: 1 }, events: [], exitCode: 0 };
  };
}

describe("supervisor", () => {
  test("resolve creates a session bound to the default workspace, stable per thread", async () => {
    const sup = new Supervisor({ defaultWorkspace: ws, run: fakeRunner("hi") });
    const a = await sup.resolve("thread-x");
    const b = await sup.resolve("thread-x");
    expect(a.id).toBe(b.id);
    expect(a.workspaceId).toBe("ws-1");
  });

  test("dispatch records user + agent turns and returns the projected reply", async () => {
    const sup = new Supervisor({ defaultWorkspace: ws, run: fakeRunner("the answer", "sid-42") });
    const r = await sup.dispatch("t1", "do the thing");
    expect(r.reply).toBe("the answer");
    expect(r.phase).toBe("done");
    const hist = await sup.history("t1");
    expect(hist.map((t) => t.role)).toEqual(["user", "agent"]);
    expect(hist[1]?.text).toBe("the answer");
  });

  test("agent session id is captured for resume continuity across turns", async () => {
    let seenResume: string | undefined = "unset";
    const sup = new Supervisor({
      defaultWorkspace: ws,
      run: async (o) => {
        seenResume = o.resumeSessionId;
        return {
          state: { phase: "done", sessionId: "sid-persist", lastText: "ok", turns: 1 },
          events: [],
          exitCode: 0,
        };
      },
    });
    await sup.dispatch("t2", "first");
    expect(seenResume).toBeUndefined(); // first turn: no resume
    await sup.dispatch("t2", "second");
    expect(seenResume).toBe("sid-persist"); // second turn resumes the captured session
  });

  test("listThreads returns threads newest-first with last-turn preview (BRO-1567)", async () => {
    const store = new InMemoryStore();
    await store.upsertWorkspace(ws);
    // Seed three sessions with explicit (out-of-order) createdAt so the sort is
    // deterministic regardless of insertion order.
    await store.upsertSession({
      id: "s-old",
      workspaceId: "ws-1",
      threadId: "t-old",
      phase: "done",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await store.addTurn({ sessionId: "s-old", role: "user", text: "hi old" });
    await store.addTurn({ sessionId: "s-old", role: "agent", text: "reply old" });
    await store.upsertSession({
      id: "s-new",
      workspaceId: "ws-1",
      threadId: "t-new",
      phase: "running",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    await store.addTurn({ sessionId: "s-new", role: "user", text: "hi new" });
    // A resolved-but-never-run thread has no turns → undefined preview.
    await store.upsertSession({
      id: "s-empty",
      workspaceId: "ws-1",
      threadId: "t-empty",
      phase: "idle",
      createdAt: "2026-01-15T00:00:00.000Z",
    });

    const sup = new Supervisor({ defaultWorkspace: ws, store, run: fakeRunner("x") });
    const threads = await sup.listThreads();
    expect(threads.map((t) => t.threadId)).toEqual(["t-new", "t-empty", "t-old"]); // newest-first
    expect(threads.find((t) => t.threadId === "t-old")?.lastText).toBe("reply old");
    expect(threads.find((t) => t.threadId === "t-new")?.lastText).toBe("hi new");
    expect(threads.find((t) => t.threadId === "t-empty")?.lastText).toBeUndefined();
    expect(threads.find((t) => t.threadId === "t-new")?.phase).toBe("running");
  });

  test("reset works for the PRINT engine (no control) — clears agentSessionId (BRO-1524)", async () => {
    // Wire the runner so we can assert the resume id actually threaded (CR #18).
    let seenResume: string | undefined = "unset";
    const sup = new Supervisor({
      defaultWorkspace: ws,
      // no `control` → print engine
      run: async (o) => {
        seenResume = o.resumeSessionId;
        return {
          state: { phase: "done", sessionId: "sid-1", lastText: "ok", turns: 1 },
          events: [],
          exitCode: 0,
        };
      },
    });
    await sup.dispatch("tr", "first"); // turn 1: no resume, captures sid-1
    expect(seenResume).toBeUndefined();
    await sup.dispatch("tr", "second"); // turn 2: resumes sid-1
    expect(seenResume).toBe("sid-1");

    const r = await sup.reset("tr");
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined(); // NOT "unsupported"
    expect(r.phase).toBe("idle");
    expect(r.alive).toBe(false); // no live process in print mode

    // After reset, the NEXT turn must start fresh — no resume id carried.
    await sup.dispatch("tr", "after-reset");
    expect(seenResume).toBeUndefined();
  });

  test("reset on a thread with no session → no-session (not unsupported)", async () => {
    const sup = new Supervisor({ defaultWorkspace: ws, run: fakeRunner("ok") });
    const r = await sup.reset("never-seen");
    expect(r).toEqual({ ok: false, reason: "no-session" });
  });

  test("trace hook receives every AgentEvent tagged with the session id (BRO-1524)", async () => {
    const seen: Array<{ sid: string; type: string }> = [];
    const sup = new Supervisor({
      defaultWorkspace: ws,
      trace: (sid, ev) => seen.push({ sid, type: ev.type }),
      run: async (o) => {
        o.onState?.(
          { phase: "running", turns: 1, sessionId: "s" },
          { type: "assistant", session_id: "s", message: { role: "assistant", content: [] } },
        );
        return {
          state: { phase: "done", sessionId: "s", lastText: "ok", turns: 1 },
          events: [],
          exitCode: 0,
        };
      },
    });
    await sup.dispatch("tt", "hi");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.type).toBe("assistant");
    expect(seen[0]?.sid).toMatch(/^sess-/); // tagged with the supervisor session id
  });

  test("a throwing trace hook does NOT fail the turn (CR #18 — side-channel)", async () => {
    const sup = new Supervisor({
      defaultWorkspace: ws,
      trace: () => {
        throw new Error("trace sink exploded");
      },
      run: async (o) => {
        o.onState?.(
          { phase: "running", turns: 1, sessionId: "s" },
          { type: "assistant", session_id: "s", message: { role: "assistant", content: [] } },
        );
        return {
          state: { phase: "done", sessionId: "s", lastText: "ok", turns: 1 },
          events: [],
          exitCode: 0,
        };
      },
    });
    const r = await sup.dispatch("tg", "hi");
    expect(r.phase).toBe("done"); // turn succeeds despite the trace throwing
    expect(r.reply).toBe("ok");
  });

  test("noWorktree → runner gets worktree:false (run-in-place, BRO-1512)", async () => {
    let seenWorktree: boolean | undefined = true;
    const sup = new Supervisor({
      defaultWorkspace: ws,
      noWorktree: true,
      run: async (o) => {
        seenWorktree = o.worktree;
        return {
          state: { phase: "done", sessionId: "s", lastText: "ok", turns: 1 },
          events: [],
          exitCode: 0,
        };
      },
    });
    await sup.dispatch("tw", "hi");
    expect(seenWorktree).toBe(false);
  });

  test("default (no noWorktree) leaves worktree unset (engine default applies)", async () => {
    let seenWorktree: boolean | undefined = false;
    const sup = new Supervisor({
      defaultWorkspace: ws,
      run: async (o) => {
        seenWorktree = o.worktree;
        return {
          state: { phase: "done", sessionId: "s", lastText: "ok", turns: 1 },
          events: [],
          exitCode: 0,
        };
      },
    });
    await sup.dispatch("tw2", "hi");
    expect(seenWorktree).toBeUndefined();
  });

  test("blocked phase propagates to the dispatch result", async () => {
    const sup = new Supervisor({ defaultWorkspace: ws, run: fakeRunner("boom", "s", "blocked") });
    const r = await sup.dispatch("t3", "break it");
    expect(r.phase).toBe("blocked");
  });
});

describe("supervisor — per-thread serialization (F19)", () => {
  test("two concurrent dispatches on one thread run sequentially, not interleaved", async () => {
    let active = 0;
    let maxConcurrent = 0;
    const order: string[] = [];
    const sup = new Supervisor({
      defaultWorkspace: ws,
      run: async (o) => {
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise((r) => setTimeout(r, 10));
        order.push(o.prompt);
        active--;
        return {
          state: { phase: "done", sessionId: "s", lastText: o.prompt, turns: 1 },
          events: [],
          exitCode: 0,
        };
      },
    });
    await Promise.all([sup.dispatch("same", "first"), sup.dispatch("same", "second")]);
    expect(maxConcurrent).toBe(1); // never overlapped
    expect(order).toEqual(["first", "second"]); // FIFO
  });
});

describe("supervisor — chains map reclaim (P20 round-2)", () => {
  test("the per-thread chain entry is reclaimed after the dispatch settles", async () => {
    const sup = new Supervisor({ defaultWorkspace: ws, run: fakeRunner("x") });
    await sup.dispatch("ephemeral", "hi");
    await new Promise((r) => setTimeout(r, 0)); // let the post-settle microtask run
    expect((sup as unknown as { chains: Map<string, unknown> }).chains.size).toBe(0);
  });
});

describe("supervisor — ensureWorkspace is not poisoned by a transient failure (P20 #1)", () => {
  test("a dispatch retries workspace persistence after the first attempt rejects", async () => {
    let calls = 0;
    const flakyStore = {
      async upsertWorkspace(w: unknown) {
        calls++;
        if (calls === 1) throw new Error("transient db blip");
        return w;
      },
      async getWorkspace() {
        return ws;
      },
      async findSessionByThread() {
        return undefined;
      },
      async upsertSession(s: unknown) {
        return s;
      },
      async addTurn(t: unknown) {
        return { ...(t as object), id: "t", createdAt: "2026-01-01T00:00:00Z" };
      },
      async turnsForSession() {
        return [];
      },
    } as unknown as ConstructorParameters<typeof Supervisor>[0]["store"];
    const sup = new Supervisor({ defaultWorkspace: ws, store: flakyStore, run: fakeRunner("ok") });
    await expect(sup.dispatch("t", "first")).rejects.toThrow("transient db blip");
    const r = await sup.dispatch("t", "second"); // not poisoned — retries the upsert
    expect(r.phase).toBe("done");
    expect(calls).toBe(2);
  });
});

describe("supervisor — remoteCwd threading (P20 MED-1)", () => {
  test("forwards remoteCwd to the runner (microVM working dir)", async () => {
    let seenRemoteCwd: string | undefined = "unset";
    const sup = new Supervisor({
      defaultWorkspace: ws,
      remoteCwd: "/vercel/sandbox/app",
      run: async (o) => {
        seenRemoteCwd = o.remoteCwd;
        return {
          state: { phase: "done", sessionId: "s", lastText: "ok", turns: 1 },
          events: [],
          exitCode: 0,
        };
      },
    });
    await sup.dispatch("t-remote", "go");
    expect(seenRemoteCwd).toBe("/vercel/sandbox/app");
  });
});

describe("supervisor — per-turn model + effort threading (BRO-1573)", () => {
  test("dispatch passes turnOpts model + effort into the runner", async () => {
    let seen: { model?: string; effort?: string } = {};
    const sup = new Supervisor({
      defaultWorkspace: ws,
      run: async (o) => {
        seen = { model: o.model, effort: o.effort };
        return {
          state: { phase: "done", sessionId: "s", lastText: "ok", turns: 1 },
          events: [],
          exitCode: 0,
        };
      },
    });
    await sup.dispatch("t-opts", "hi", undefined, { model: "haiku", effort: "max" });
    expect(seen).toEqual({ model: "haiku", effort: "max" });
  });

  test("omitted turnOpts leaves model/effort undefined (engine default)", async () => {
    let seen: { model?: string; effort?: string } = { model: "x", effort: "x" };
    const sup = new Supervisor({
      defaultWorkspace: ws,
      run: async (o) => {
        seen = { model: o.model, effort: o.effort };
        return {
          state: { phase: "done", sessionId: "s", lastText: "ok", turns: 1 },
          events: [],
          exitCode: 0,
        };
      },
    });
    await sup.dispatch("t-default", "hi");
    expect(seen).toEqual({ model: undefined, effort: undefined });
  });
});

describe("supervisor — session management (BRO-1592)", () => {
  test("deriveTitle takes the first ~6 words of the first line", () => {
    expect(deriveTitle("  fix   the   login   bug  ")).toBe("fix the login bug");
    expect(deriveTitle("one two three four five six seven eight")).toBe(
      "one two three four five six",
    );
    expect(deriveTitle("first line\nsecond line")).toBe("first line");
    expect(deriveTitle("   \n  ")).toBeUndefined();
  });

  test("first user turn auto-derives a title; listThreads carries title + archived=false", async () => {
    const sup = new Supervisor({ defaultWorkspace: ws, run: fakeRunner("ok") });
    await sup.dispatch("t-title", "summarize the workspace state please");
    const [row] = await sup.listThreads();
    expect(row?.title).toBe("summarize the workspace state please");
    expect(row?.archived).toBe(false);
  });

  test("title is not overwritten by a later turn", async () => {
    const sup = new Supervisor({ defaultWorkspace: ws, run: fakeRunner("ok") });
    await sup.dispatch("t-keep", "original question");
    await sup.dispatch("t-keep", "a follow up");
    const [row] = await sup.listThreads();
    expect(row?.title).toBe("original question");
  });

  test("archiveThread toggles the archived flag; restore clears it", async () => {
    const sup = new Supervisor({ defaultWorkspace: ws, run: fakeRunner("ok") });
    await sup.dispatch("t-arch", "hello");
    expect((await sup.archiveThread("t-arch", true)).ok).toBe(true);
    expect((await sup.listThreads())[0]?.archived).toBe(true);
    await sup.archiveThread("t-arch", false);
    expect((await sup.listThreads())[0]?.archived).toBe(false);
  });

  test("setTitle renames; empty title clears back to undefined", async () => {
    const sup = new Supervisor({ defaultWorkspace: ws, run: fakeRunner("ok") });
    await sup.dispatch("t-name", "first question here");
    await sup.setTitle("t-name", "Renamed thread");
    expect((await sup.listThreads())[0]?.title).toBe("Renamed thread");
    await sup.setTitle("t-name", "   ");
    expect((await sup.listThreads())[0]?.title).toBeUndefined();
  });

  test("deleteThread removes the thread + its transcript", async () => {
    const sup = new Supervisor({ defaultWorkspace: ws, run: fakeRunner("ok") });
    await sup.dispatch("t-del", "delete me");
    expect(await sup.listThreads()).toHaveLength(1);
    expect((await sup.deleteThread("t-del")).ok).toBe(true);
    expect(await sup.listThreads()).toHaveLength(0);
    expect(await sup.history("t-del")).toEqual([]);
  });

  test("archive/rename/delete on an unknown thread → no-session", async () => {
    const sup = new Supervisor({ defaultWorkspace: ws, run: fakeRunner("ok") });
    expect((await sup.archiveThread("nope", true)).reason).toBe("no-session");
    expect((await sup.setTitle("nope", "x")).reason).toBe("no-session");
    expect((await sup.deleteThread("nope")).reason).toBe("no-session");
  });
});
