import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "@genesis/runner";
import { InMemoryStore } from "./store";
import { Supervisor, deriveTitle } from "./supervisor";
import { InMemoryWorkspaceRepository } from "./workspace-repository";

// A pid-unique real dir (not a fixed /tmp path) so the BRO-1630 RC3 vanished-
// workspace guard (enforced on local hosts) lets dispatch through, without
// aliasing a pre-existing dir or leaking state across runs (P20 #5). Tests that
// use OTHER fake rootPaths inject `workspaceExists: () => true` to bypass the guard.
const ws = { id: "ws-1", name: "test", rootPath: join(tmpdir(), `genesis-test-${process.pid}`) };
beforeAll(() => mkdirSync(ws.rootPath, { recursive: true }));
afterAll(() => rmSync(ws.rootPath, { recursive: true, force: true }));

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

  // Records which engine's runner ran, by id.
  function trackingRunner(id: string, calls: string[]): (o: any) => Promise<RunResult> {
    return async () => {
      calls.push(id);
      return {
        state: { phase: "done", sessionId: `s-${id}`, lastText: id, turns: 1 },
        events: [],
        exitCode: 0,
      };
    };
  }

  test("engine registry: per-thread STICKY binding (BRO-1620)", async () => {
    const calls: string[] = [];
    const store = new InMemoryStore();
    const sup = new Supervisor({
      defaultWorkspace: ws,
      store,
      runners: {
        print: trackingRunner("print", calls),
        interactive: trackingRunner("interactive", calls),
      },
      defaultEngine: "print",
    });
    // Turn 1 requests interactive → runs it AND binds the session to it.
    await sup.dispatch("te", "one", undefined, { engine: "interactive" });
    expect(calls.at(-1)).toBe("interactive");
    expect((await store.findSessionByThread("te"))?.engine).toBe("interactive");
    // Turn 2 requests print → IGNORED (sticky); the thread stays interactive.
    await sup.dispatch("te", "two", undefined, { engine: "print" });
    expect(calls.at(-1)).toBe("interactive");
  });

  test("engine registry: absent → default; unknown → default, no crash (BRO-1620)", async () => {
    const calls: string[] = [];
    const sup = new Supervisor({
      defaultWorkspace: ws,
      runners: {
        print: trackingRunner("print", calls),
        interactive: trackingRunner("interactive", calls),
      },
      defaultEngine: "interactive",
    });
    await sup.dispatch("td1", "x"); // no engine → defaultEngine (interactive)
    expect(calls.at(-1)).toBe("interactive");
    await sup.dispatch("td2", "y", undefined, { engine: "quantum" }); // unknown → default
    expect(calls.at(-1)).toBe("interactive");
  });

  test("engine registry: a pre-1620 thread that already ran binds DEFAULT, not the requested (BRO-1620 P20)", async () => {
    const calls: string[] = [];
    const store = new InMemoryStore();
    // A pre-BRO-1620 row: it already ran (agentSessionId set) but has NO engine.
    await store.upsertSession({
      id: "sess-old",
      workspaceId: ws.id,
      threadId: "told",
      phase: "done",
      createdAt: new Date().toISOString(),
      agentSessionId: "claude-sid-old",
    });
    const sup = new Supervisor({
      defaultWorkspace: ws,
      store,
      runners: {
        print: trackingRunner("print", calls),
        interactive: trackingRunner("interactive", calls),
      },
      defaultEngine: "print",
    });
    // The client requests interactive, but an existing-that-ran thread must bind the
    // DEFAULT (print) — preserving its actual engine, not silently rerouting it.
    await sup.dispatch("told", "next", undefined, { engine: "interactive" });
    expect(calls.at(-1)).toBe("print");
    expect((await store.findSessionByThread("told"))?.engine).toBe("print");
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

describe("supervisor — token usage (BRO-1597)", () => {
  const usage = { input: 500, output: 40, cacheRead: 10, cacheCreation: 2 };

  test("dispatch surfaces usage + cost from the run; the agent turn persists them", async () => {
    const sup = new Supervisor({
      defaultWorkspace: ws,
      run: async () => ({
        state: { phase: "done", sessionId: "s", lastText: "ok", turns: 1, usage, costUsd: 0.005 },
        events: [],
        exitCode: 0,
      }),
    });
    const r = await sup.dispatch("t-usage", "hi");
    expect(r.usage).toEqual(usage);
    expect(r.costUsd).toBe(0.005);
    const agentTurn = (await sup.history("t-usage")).find((t) => t.role === "agent");
    expect(agentTurn?.usage).toEqual(usage);
    expect(agentTurn?.costUsd).toBe(0.005);
  });

  test("a run without usage yields undefined usage/cost (not zeroes)", async () => {
    const sup = new Supervisor({ defaultWorkspace: ws, run: fakeRunner("ok") });
    const r = await sup.dispatch("t-nousage", "hi");
    expect(r.usage).toBeUndefined();
    expect(r.costUsd).toBeUndefined();
  });
});

describe("supervisor — workspace selection (BRO-1627)", () => {
  const wsA = { id: "ws-a", name: "alpha", rootPath: "/repos/alpha" };
  const wsB = { id: "ws-b", name: "beta", rootPath: "/repos/beta", noWorktree: true };

  // Capture the cwd + worktree flag the LAST turn ran with.
  function cwdRunner(sink: { cwd?: string; worktree?: unknown }): (o: any) => Promise<RunResult> {
    return async (o) => {
      sink.cwd = o.cwd;
      sink.worktree = o.worktree;
      return {
        state: { phase: "done", sessionId: "s", lastText: "ok", turns: 1 },
        events: [],
        exitCode: 0,
      };
    };
  }

  test("a NEW thread binds + runs in the requested registered workspace", async () => {
    const sink: { cwd?: string } = {};
    const store = new InMemoryStore();
    const sup = new Supervisor({
      defaultWorkspace: ws,
      workspaces: [wsA, wsB],
      store,
      workspaceExists: () => true, // fake /repos/* paths — bypass the RC3 guard
      run: cwdRunner(sink),
    });
    await sup.dispatch("t-ws", "go", undefined, { workspaceId: "ws-a" });
    expect(sink.cwd).toBe("/repos/alpha");
    expect((await store.findSessionByThread("t-ws"))?.workspaceId).toBe("ws-a");
  });

  test("an unregistered workspaceId falls back to the default workspace", async () => {
    const sink: { cwd?: string } = {};
    const sup = new Supervisor({ defaultWorkspace: ws, workspaces: [wsA], run: cwdRunner(sink) });
    await sup.dispatch("t-unk", "go", undefined, { workspaceId: "ws-nope" });
    expect(sink.cwd).toBe(ws.rootPath);
  });

  test("binding is STICKY at creation — a turn-2 workspaceId is ignored", async () => {
    const sink: { cwd?: string } = {};
    const store = new InMemoryStore();
    const sup = new Supervisor({
      defaultWorkspace: ws,
      workspaces: [wsA, wsB],
      store,
      workspaceExists: () => true, // fake /repos/* paths — bypass the RC3 guard
      run: cwdRunner(sink),
    });
    await sup.dispatch("t-stick", "one", undefined, { workspaceId: "ws-a" });
    expect(sink.cwd).toBe("/repos/alpha");
    await sup.dispatch("t-stick", "two", undefined, { workspaceId: "ws-b" }); // ignored
    expect(sink.cwd).toBe("/repos/alpha");
    expect((await store.findSessionByThread("t-stick"))?.workspaceId).toBe("ws-a");
  });

  test("resolve binds the requested workspace at creation; default when omitted", async () => {
    // ws-b is REGISTERED so the sticky assertion isolates stickiness (P20 N4): if
    // resolve weren't sticky, the second call WOULD rebind to the valid ws-b.
    const sup = new Supervisor({
      defaultWorkspace: ws,
      workspaces: [wsA, wsB],
      run: fakeRunner("x"),
    });
    expect((await sup.resolve("r1", "ws-a")).workspaceId).toBe("ws-a");
    expect((await sup.resolve("r2")).workspaceId).toBe("ws-1");
    // sticky: a second resolve with a different REGISTERED id keeps the first.
    expect((await sup.resolve("r1", "ws-b")).workspaceId).toBe("ws-a");
  });

  test("per-workspace noWorktree wins over the supervisor global", async () => {
    const last: { cwd?: string; worktree?: unknown } = {};
    const sup = new Supervisor({
      defaultWorkspace: ws,
      workspaces: [wsA, wsB],
      noWorktree: false, // global default: use worktrees
      workspaceExists: () => true, // fake /repos/* paths — bypass the RC3 guard
      run: cwdRunner(last),
    });
    await sup.dispatch("tA", "x", undefined, { workspaceId: "ws-a" });
    expect(last.worktree).toBeUndefined(); // wsA inherits global false → worktree enabled
    await sup.dispatch("tB", "y", undefined, { workspaceId: "ws-b" });
    expect(last.worktree).toBe(false); // wsB declares noWorktree → run direct
  });

  test("listWorkspaces returns the default first, then the extras", async () => {
    const sup = new Supervisor({
      defaultWorkspace: ws,
      workspaces: [wsA, wsB],
      run: fakeRunner("x"),
    });
    expect((await sup.listWorkspaces()).map((w) => w.id)).toEqual(["ws-1", "ws-a", "ws-b"]);
    expect(sup.defaultWorkspaceId).toBe("ws-1");
  });

  test("listWorkspaces is a public DTO — never exposes rootPath (P20/CodeRabbit)", async () => {
    const sup = new Supervisor({ defaultWorkspace: ws, workspaces: [wsA], run: fakeRunner("x") });
    for (const w of await sup.listWorkspaces()) {
      expect("rootPath" in w).toBe(false);
      expect("noWorktree" in w).toBe(false);
    }
    expect((await sup.listWorkspaces()).map((w) => w.id)).toEqual(["ws-1", "ws-a"]);
  });

  test("an explicit workspace overrides a same-id earlier entry (registry merge order)", async () => {
    const sink: { cwd?: string } = {};
    const dupe = { id: "ws-a", name: "alpha-override", rootPath: "/repos/alpha-2" };
    const sup = new Supervisor({
      defaultWorkspace: ws,
      workspaces: [wsA, dupe], // later wins
      workspaceExists: () => true, // fake /repos/* paths — bypass the RC3 guard
      run: cwdRunner(sink),
    });
    // The override's rootPath wins — asserted via the actual run cwd (listWorkspaces
    // no longer exposes rootPath; the cwd is the real behavior).
    await sup.dispatch("t-dupe", "go", undefined, { workspaceId: "ws-a" });
    expect(sink.cwd).toBe("/repos/alpha-2");
  });

  test("listThreads carries the bound workspace id + name", async () => {
    const store = new InMemoryStore();
    const sup = new Supervisor({
      defaultWorkspace: ws,
      workspaces: [wsA],
      store,
      workspaceExists: () => true, // fake /repos/alpha — bypass the RC3 guard
      run: fakeRunner("x"),
    });
    await sup.dispatch("twl", "go", undefined, { workspaceId: "ws-a" });
    const t = (await sup.listThreads()).find((x) => x.threadId === "twl");
    expect(t?.workspaceId).toBe("ws-a");
    expect(t?.workspaceName).toBe("alpha");
  });

  test("a deconfigured workspace that ALREADY RAN errors instead of silently re-cwd'ing", async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: "sess-gone",
      workspaceId: "ws-gone", // neither in the registry nor the store
      threadId: "tgone",
      phase: "done",
      createdAt: new Date().toISOString(),
      agentSessionId: "claude-sid", // ← it ran; --resume continuity must be protected
    });
    const sup = new Supervisor({ defaultWorkspace: ws, store, run: fakeRunner("x") });
    await expect(sup.dispatch("tgone", "next")).rejects.toThrow(/no longer available/);
  });

  test("a registry-missing workspace still in the DB ALSO errors on a ran thread (P20 S1)", async () => {
    // The DB row survives (ensureWorkspace persisted it) but carries no worktree
    // posture, so a ran thread can't be safely resumed even with a DB hit.
    const store = new InMemoryStore();
    await store.upsertWorkspace({ id: "ws-x", name: "x", rootPath: "/repos/x" });
    await store.upsertSession({
      id: "sess-x",
      workspaceId: "ws-x", // in the DB, NOT in the boot registry
      threadId: "tx",
      phase: "done",
      createdAt: new Date().toISOString(),
      agentSessionId: "sid-x", // ran
    });
    const sup = new Supervisor({ defaultWorkspace: ws, store, run: fakeRunner("x") });
    await expect(sup.dispatch("tx", "next")).rejects.toThrow(/no longer available/);
  });

  test("a registry-missing workspace on a NEVER-RAN thread falls back without error", async () => {
    // never ran → no --resume to break → safe to run at the last-known DB path.
    const sink: { cwd?: string } = {};
    const store = new InMemoryStore();
    await store.upsertWorkspace({ id: "ws-y", name: "y", rootPath: "/repos/y" });
    await store.upsertSession({
      id: "sess-y",
      workspaceId: "ws-y",
      threadId: "ty",
      phase: "idle",
      createdAt: new Date().toISOString(), // no agentSessionId → never ran
    });
    const sup = new Supervisor({
      defaultWorkspace: ws,
      store,
      workspaceExists: () => true, // fake /repos/y — bypass the RC3 guard (tests fallback, not fs)
      run: cwdRunner(sink),
    });
    await sup.dispatch("ty", "first");
    expect(sink.cwd).toBe("/repos/y");
  });

  test("an extra colliding with the default id is IGNORED (default can't be shadowed, P20 M2)", async () => {
    const sink: { cwd?: string } = {};
    const shadow = { id: "ws-1", name: "evil", rootPath: "/repos/evil" }; // ws-1 = default id
    const sup = new Supervisor({
      defaultWorkspace: ws, // id ws-1, rootPath /tmp/genesis-test
      workspaces: [shadow],
      run: cwdRunner(sink),
    });
    // ws-1 appears once (the shadow was dropped), and a default-bound thread runs
    // in the GENUINE default tree — not the shadow's (asserted via the run cwd,
    // since listWorkspaces no longer exposes rootPath).
    expect((await sup.listWorkspaces()).filter((w) => w.id === "ws-1").length).toBe(1);
    await sup.dispatch("t-shadow", "go");
    expect(sink.cwd).toBe(ws.rootPath);
  });

  test("registerWorkspace adds a workspace at runtime (no restart) — bindable + listed (BRO-1629)", async () => {
    const sink: { cwd?: string } = {};
    const sup = new Supervisor({
      defaultWorkspace: ws,
      workspaceExists: () => true, // fake /repos/live — bypass the RC3 guard
      run: cwdRunner(sink),
    });
    expect((await sup.listWorkspaces()).map((w) => w.id)).toEqual(["ws-1"]); // just the default
    await sup.registerWorkspace({ id: "ws-live", name: "live", rootPath: "/repos/live" });
    expect((await sup.listWorkspaces()).map((w) => w.id)).toEqual(["ws-1", "ws-live"]);
    // a NEW thread can bind the just-registered workspace immediately.
    await sup.dispatch("t-live", "go", undefined, { workspaceId: "ws-live" });
    expect(sink.cwd).toBe("/repos/live");
  });

  test("registerWorkspace is idempotent by rootPath — a double-submit never dups a directory (BRO-1629, P11 dogfood)", async () => {
    const sup = new Supervisor({ defaultWorkspace: ws, run: fakeRunner("x") });
    const first = await sup.registerWorkspace({
      id: "ws-proj",
      name: "proj",
      rootPath: "/repos/proj",
    });
    // A second add of the SAME dir resolves to a DISAMBIGUATED id (the clean id
    // is now taken) but the same rootPath — must return the EXISTING workspace,
    // not append a second entry for one directory.
    const second = await sup.registerWorkspace({
      id: "ws-proj-abc123",
      name: "proj",
      rootPath: "/repos/proj",
    });
    expect(second.id).toBe("ws-proj"); // the existing id, not the new one
    expect(second).toEqual(first);
    expect((await sup.listWorkspaces()).map((w) => w.id)).toEqual(["ws-1", "ws-proj"]);
  });

  test("registerWorkspace rejects the reserved default id (BRO-1629)", async () => {
    const sup = new Supervisor({ defaultWorkspace: ws, run: fakeRunner("x") });
    await expect(
      sup.registerWorkspace({ id: "ws-1", name: "evil", rootPath: "/repos/evil" }),
    ).rejects.toThrow(/reserved/);
  });

  test("removeWorkspace de-registers; the default can't be removed (BRO-1629)", async () => {
    const sup = new Supervisor({
      defaultWorkspace: ws,
      workspaces: [wsA],
      run: fakeRunner("x"),
    });
    expect((await sup.listWorkspaces()).map((w) => w.id)).toEqual(["ws-1", "ws-a"]);
    expect(await sup.removeWorkspace("ws-a")).toBe(true);
    expect((await sup.listWorkspaces()).map((w) => w.id)).toEqual(["ws-1"]);
    expect(await sup.removeWorkspace("ws-1")).toBe(false); // default is protected
    expect((await sup.listWorkspaces()).map((w) => w.id)).toEqual(["ws-1"]);
  });

  test("a custom WorkspaceRepository is the source of truth; env seed is skipped when non-empty (BRO-1629)", async () => {
    const repo = new InMemoryWorkspaceRepository([
      { id: "ws-1", name: "genesis", rootPath: "/tmp/genesis-test" },
      { id: "ws-fromrepo", name: "fromrepo", rootPath: "/repos/fromrepo" },
    ]);
    // env seed (workspaces:[wsA]) is IGNORED because the repo is already populated.
    const sup = new Supervisor({
      defaultWorkspace: ws,
      workspaces: [wsA],
      workspaceRepository: repo,
      run: fakeRunner("x"),
    });
    expect((await sup.listWorkspaces()).map((w) => w.id).sort()).toEqual(["ws-1", "ws-fromrepo"]);
  });

  test("a repository entry sharing the default id can't SHADOW the genuine default (P20 Forge #1)", async () => {
    const sink: { cwd?: string } = {};
    // The repo carries a `ws-1` (the default id) with a DIFFERENT rootPath/name.
    const repo = new InMemoryWorkspaceRepository([
      { id: "ws-1", name: "SHADOW", rootPath: "/evil/shadow" },
      { id: "ws-x", name: "x", rootPath: "/repos/x" },
    ]);
    const sup = new Supervisor({
      defaultWorkspace: ws, // id ws-1, name "test", rootPath /tmp/genesis-test
      workspaceRepository: repo,
      run: cwdRunner(sink),
    });
    // listWorkspaces reports the GENUINE default (name "test"), not the shadow.
    expect((await sup.listWorkspaces()).find((w) => w.id === "ws-1")?.name).toBe("test");
    // A default-bound thread runs in the GENUINE default tree, never /evil/shadow.
    await sup.dispatch("t-shadow-repo", "go");
    expect(sink.cwd).toBe(ws.rootPath);
  });

  test("concurrent runtime registers don't lose an update (serialized refresh, P20/CR #2)", async () => {
    const sup = new Supervisor({ defaultWorkspace: ws, run: fakeRunner("x") });
    // Two registers race — overlapping hydrations must not let a slower stale
    // reload overwrite the cache and drop one. Both must survive.
    await Promise.all([
      sup.registerWorkspace({ id: "ws-p", name: "p", rootPath: "/p" }),
      sup.registerWorkspace({ id: "ws-q", name: "q", rootPath: "/q" }),
    ]);
    expect((await sup.listWorkspaces()).map((w) => w.id).sort()).toEqual(["ws-1", "ws-p", "ws-q"]);
  });
});

describe("supervisor — workspace availability guard (BRO-1629 slice 4 / BRO-1630 RC3)", () => {
  const gone = { id: "ws-gone", name: "ghost", rootPath: `/tmp/genesis-vanished-${process.pid}` };

  test("dispatch into a vanished rootPath throws a clear error, NEVER spawns, and leaves the session BLOCKED (not phantom-running, P20 #1)", async () => {
    let ran = false;
    const store = new InMemoryStore();
    const sup = new Supervisor({
      defaultWorkspace: gone, // real existsSync → the dir does not exist → guarded
      store,
      run: async () => {
        ran = true;
        return {
          state: { phase: "done", sessionId: "s", lastText: "x", turns: 1 },
          events: [],
          exitCode: 0,
        };
      },
    });
    await expect(sup.dispatch("t-vanished", "hi")).rejects.toThrow(/unavailable|no longer exists/i);
    expect(ran).toBe(false); // guarded BEFORE the runner was invoked (no phantom-cwd spawn)
    // The throw must NOT leave the session persisted "running" (a forever-spinner
    // in the UI) — the catch resets it to blocked.
    expect((await store.findSessionByThread("t-vanished"))?.phase).toBe("blocked");
  });

  test("the guard is skipped for NON-local hosts (repo lives inside the VM)", async () => {
    let ran = false;
    const microHost = {
      kind: "microvm" as const,
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      spawnStream: () => {
        throw new Error("unused");
      },
    };
    const sup = new Supervisor({
      defaultWorkspace: gone, // vanished LOCAL path, but the host is a microVM
      host: microHost as unknown as import("@genesis/host").ExecutionHost,
      run: async () => {
        ran = true;
        return {
          state: { phase: "done", sessionId: "s", lastText: "ok", turns: 1 },
          events: [],
          exitCode: 0,
        };
      },
    });
    const r = await sup.dispatch("t-micro", "hi");
    expect(ran).toBe(true); // no local existsSync check for a microVM host
    expect(r.phase).toBe("done");
  });

  test("listWorkspaces annotates availability (present → true, vanished → false)", async () => {
    const sup = new Supervisor({ defaultWorkspace: ws, workspaces: [gone], run: fakeRunner("x") });
    const list = await sup.listWorkspaces();
    expect(list.find((w) => w.id === ws.id)?.available).toBe(true); // beforeAll mkdir'd
    expect(list.find((w) => w.id === gone.id)?.available).toBe(false);
    // Still a public DTO — availability never leaks the rootPath.
    for (const w of list) expect("rootPath" in w).toBe(false);
  });

  test("an injected workspaceExists bypasses the guard (fake-path unit tests)", async () => {
    let ran = false;
    const sup = new Supervisor({
      defaultWorkspace: gone,
      workspaceExists: () => true, // pretend it exists
      run: async () => {
        ran = true;
        return {
          state: { phase: "done", sessionId: "s", lastText: "ok", turns: 1 },
          events: [],
          exitCode: 0,
        };
      },
    });
    await sup.dispatch("t-inject", "hi");
    expect(ran).toBe(true);
  });
});
