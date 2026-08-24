import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionHost } from "@genesis/host";
import type { RunResult } from "@genesis/runner";
import { STACK_AGENTS } from "./agent-stack";
import { TurnRejectedError } from "./concurrency";
import { InMemoryStore } from "./store";
import {
  Supervisor,
  buildTitlePrompt,
  deriveTitle,
  hardenedExtraArgs,
  homeRefusal,
  sanitizeTitle,
} from "./supervisor";
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

  // ── Per-session worktree binding (BRO-1656) ──
  /** A runner that records the `worktree` RunOption for every turn + returns a
   *  sessionId so a second dispatch is NOT treated as turn 1 (sticky check). */
  function worktreeSpy(seen: (boolean | undefined)[]) {
    return async (o: any): Promise<RunResult> => {
      seen.push(o.worktree);
      return {
        state: { phase: "done", sessionId: "s", lastText: "ok", turns: 1 },
        events: [],
        exitCode: 0,
      };
    };
  }

  test("per-session worktree:false → runner runs at ROOT (BRO-1656)", async () => {
    const seen: (boolean | undefined)[] = [];
    const sup = new Supervisor({ defaultWorkspace: ws, run: worktreeSpy(seen) });
    await sup.dispatch("tw3", "hi", undefined, { worktree: false });
    expect(seen).toEqual([false]); // noWorktree true → worktree:false
  });

  test("per-session worktree:true → runner CUTS a worktree (BRO-1656)", async () => {
    const seen: (boolean | undefined)[] = [];
    const sup = new Supervisor({ defaultWorkspace: ws, run: worktreeSpy(seen) });
    await sup.dispatch("tw4", "hi", undefined, { worktree: true });
    expect(seen).toEqual([undefined]); // noWorktree false → worktree left unset (cut one)
  });

  test("worktree choice is STICKY — a later turn ignores a changed request (BRO-1656)", async () => {
    const seen: (boolean | undefined)[] = [];
    const sup = new Supervisor({ defaultWorkspace: ws, run: worktreeSpy(seen) });
    await sup.dispatch("tw5", "one", undefined, { worktree: false }); // bind root
    await sup.dispatch("tw5", "two", undefined, { worktree: true }); // ignored (sticky)
    expect(seen).toEqual([false, false]); // both root
  });

  test("safety: worktree:true is IGNORED when the deploy default forces root (BRO-1656/BRO-1512)", async () => {
    const seen: (boolean | undefined)[] = [];
    const sup = new Supervisor({
      defaultWorkspace: ws,
      noWorktree: true, // deploy-global root (e.g. a nested-repo default workspace)
      run: worktreeSpy(seen),
    });
    await sup.dispatch("tw6", "hi", undefined, { worktree: true }); // asks for a worktree
    expect(seen).toEqual([false]); // still root — never cut a worktree onto a nested repo
  });

  test("a fallback (non-registered) workspace forces ROOT — unverifiable posture (BRO-1656 P20 F5)", async () => {
    const seen: (boolean | undefined)[] = [];
    const store = new InMemoryStore();
    // A workspace known to the STORE (DB row: id/name/rootPath) but NOT the registry,
    // so its registry-only `noWorktree` is lost. A never-run session bound to it.
    await store.upsertWorkspace({ id: "ws-ghost", name: "ghost", rootPath: ws.rootPath });
    await store.upsertSession({
      id: "sg",
      workspaceId: "ws-ghost",
      threadId: "tg",
      phase: "idle",
      createdAt: new Date().toISOString(),
    });
    const sup = new Supervisor({ defaultWorkspace: ws, store, run: worktreeSpy(seen) });
    await sup.dispatch("tg", "hi", undefined, { worktree: true }); // asks for a worktree
    expect(seen).toEqual([false]); // forced root — can't verify the workspace isn't nested
  });

  test("an inheriting thread FREEZES its posture on turn 1 — no cwd bounce on a later default flip (BRO-1656 CodeRabbit)", async () => {
    const seen: (boolean | undefined)[] = [];
    const store = new InMemoryStore();
    // No explicit choice + deploy-global root → the thread INHERITS root, and that
    // posture is persisted so a later workspace-default flip can't bounce its cwd
    // (which would break claude --resume continuity).
    const sup = new Supervisor({
      defaultWorkspace: ws,
      store,
      noWorktree: true,
      run: worktreeSpy(seen),
    });
    await sup.dispatch("tf", "one"); // inherit → root
    expect(seen).toEqual([false]);
    expect((await store.findSessionByThread("tf"))?.noWorktree).toBe(true); // FROZEN, not undefined
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

  // ── BRO-2236 / BRO-2241 ────────────────────────────────────────────────────
  // The leniencies above are CORRECT for a human picking a workspace and dangerous
  // for a public channel. Every case below is PAIRED: a refusal on its own is not
  // evidence, because a blanket refusal would also produce it. Each negative sits
  // beside a positive proving the same apparatus still serves a legitimate turn.

  test("channel-qualified: an UNREGISTERED id is refused, a REGISTERED one is still served", async () => {
    const sink: { cwd?: string } = {};
    const sup = new Supervisor({
      defaultWorkspace: ws,
      workspaces: [wsA],
      workspaceExists: () => true,
      run: cwdRunner(sink),
    });
    // NEGATIVE — must refuse rather than resolve to the default workspace, which on
    // the box is /home/agent, i.e. the PII directory (BRO-2236).
    await expect(
      sup.dispatch("t-ch-unk", "go", undefined, {
        workspaceId: "ws-nope",
        channelQualified: true,
      }),
    ).rejects.toThrow(/not registered/);
    expect(sink.cwd).toBeUndefined(); // never ran anywhere, least of all the default

    // POSITIVE CONTROL — same supervisor, same flag, a registered id still runs.
    await sup.dispatch("t-ch-ok", "go", undefined, {
      workspaceId: "ws-a",
      channelQualified: true,
    });
    expect(sink.cwd).toBe("/repos/alpha");
  });

  test("channel-qualified: a STALE binding is refused, a matching one still dispatches", async () => {
    const sink: { cwd?: string } = {};
    const store = new InMemoryStore();
    const sup = new Supervisor({
      defaultWorkspace: ws,
      workspaces: [wsA, wsB],
      store,
      workspaceExists: () => true,
      run: cwdRunner(sink),
    });
    await sup.dispatch("t-ch-stick", "one", undefined, {
      workspaceId: "ws-a",
      channelQualified: true,
    });
    expect(sink.cwd).toBe("/repos/alpha");

    // NEGATIVE — this is the measured live defect: a row minted before its channel
    // had a confined workspace keeps the old binding forever, and resolve() never
    // looks at the caller's id again. Silently serving ws-a here is the bug.
    await expect(
      sup.dispatch("t-ch-stick", "two", undefined, {
        workspaceId: "ws-b",
        channelQualified: true,
      }),
    ).rejects.toThrow(/bound to workspace ws-a/);
    expect((await store.findSessionByThread("t-ch-stick"))?.workspaceId).toBe("ws-a");

    // POSITIVE CONTROL — re-asserting the SAME id is not a re-bind and must serve,
    // otherwise the refusal above would be indistinguishable from "channels are
    // broken", which is the failure mode a bare negative cannot rule out.
    // A SENTINEL rather than undefined: it keeps the type a string (assigning
    // undefined narrows sink.cwd for the rest of the block) and it is the stronger
    // control anyway — asserting /repos/alpha now proves the third dispatch actually
    // WROTE cwd, where a cleared value only proves it is no longer empty.
    sink.cwd = "/sentinel-never-dispatched";
    await sup.dispatch("t-ch-stick", "three", undefined, {
      workspaceId: "ws-a",
      channelQualified: true,
    });
    expect(sink.cwd).toBe("/repos/alpha");
  });

  test("the refusals are OFF by default — the web UI keeps BRO-1627 leniency", async () => {
    // Polarity guard: without the flag both refusals must stay dormant, or this
    // change would silently break every non-channel caller.
    const sink: { cwd?: string } = {};
    const sup = new Supervisor({ defaultWorkspace: ws, workspaces: [wsA], run: cwdRunner(sink) });
    await sup.dispatch("t-web-unk", "go", undefined, { workspaceId: "ws-nope" });
    expect(sink.cwd).toBe(ws.rootPath);
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

  test("listWorkspaces surfaces worktreeCapable, folding global + per-workspace (BRO-1657)", async () => {
    // Global default = worktrees ON. wsA inherits it (capable), wsB declares
    // noWorktree (not capable), the default ws-1 inherits (capable).
    const sup = new Supervisor({
      defaultWorkspace: ws,
      workspaces: [wsA, wsB],
      noWorktree: false,
      run: fakeRunner("x"),
    });
    const byId = new Map((await sup.listWorkspaces()).map((w) => [w.id, w.worktreeCapable]));
    expect(byId.get("ws-1")).toBe(true);
    expect(byId.get("ws-a")).toBe(true);
    expect(byId.get("ws-b")).toBe(false); // per-workspace noWorktree → not capable
  });

  test("listWorkspaces worktreeCapable is false for EVERY workspace on a global-noWorktree box (BRO-1657)", async () => {
    // A deploy that forces root globally (e.g. GENESIS_NO_WORKTREE=1) reports every
    // workspace as incapable, so the launcher toggle is forced-root everywhere.
    const sup = new Supervisor({
      defaultWorkspace: ws,
      workspaces: [wsA, wsB],
      noWorktree: true,
      run: fakeRunner("x"),
    });
    for (const w of await sup.listWorkspaces()) {
      expect(w.worktreeCapable).toBe(false);
    }
  });

  test("listThreads carries the bound worktree posture (BRO-1656/1657)", async () => {
    const store = new InMemoryStore();
    const sup = new Supervisor({
      defaultWorkspace: ws,
      workspaces: [wsA],
      store,
      workspaceExists: () => true,
      run: cwdRunner({}),
    });
    // worktree:false → the session binds noWorktree=true (run at root), surfaced.
    await sup.dispatch("twt", "go", undefined, { workspaceId: "ws-a", worktree: false });
    const t = (await sup.listThreads()).find((x) => x.threadId === "twt");
    expect(t?.noWorktree).toBe(true);
  });

  test("listThreads carries the cwd branch captured from the run (BRO-1664)", async () => {
    const store = new InMemoryStore();
    // A runner that reports the cwd branch on its result (root → repo branch).
    const branchRunner = async (): Promise<RunResult> => ({
      state: { phase: "done", sessionId: "sb", lastText: "ok", turns: 1 },
      events: [],
      exitCode: 0,
      branch: "main",
    });
    const sup = new Supervisor({
      defaultWorkspace: ws,
      workspaces: [wsA],
      store,
      workspaceExists: () => true,
      run: branchRunner,
    });
    await sup.dispatch("tbr", "go", undefined, { workspaceId: "ws-a" });
    const t = (await sup.listThreads()).find((x) => x.threadId === "tbr");
    expect(t?.branch).toBe("main");
    // Persisted on the session (survives reload).
    expect((await store.findSessionByThread("tbr"))?.branch).toBe("main");
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

  test("registerWorkspace seeds the agent stack into a workspace that exists on disk (BRO-2252)", async () => {
    const root = mkdtempSync(join(tmpdir(), "genesis-sup-seed-"));
    const sup = new Supervisor({ defaultWorkspace: ws, run: fakeRunner("x") });
    await sup.registerWorkspace({ id: "ws-seed", name: "seed", rootPath: root });
    for (const a of STACK_AGENTS) {
      expect(existsSync(join(root, ".claude", "agents", `${a.name}.md`))).toBe(true);
    }
  });

  // The NEGATIVE half, and the reason the guard is the real existsSync rather
  // than the injectable probe: a test that fakes `workspaceExists` for a path
  // like /repos/live must not cause a real mkdir at the filesystem root.
  test("registerWorkspace does NOT seed a rootPath that is not on this filesystem (BRO-2252)", async () => {
    const seen: string[] = [];
    const sup = new Supervisor({
      defaultWorkspace: ws,
      workspaceExists: () => true, // lies, as the existing tests do
      run: fakeRunner("x"),
      stackSeeder: (rootPath) => seen.push(rootPath),
    });
    await sup.registerWorkspace({ id: "ws-remote", name: "remote", rootPath: "/repos/remote" });
    expect(seen).toEqual([]);
  });

  // A seeder that throws must not fail the registration: a workspace with no
  // seeded agents still works, one that failed to register does not.
  test("registerWorkspace survives a seeder that throws (BRO-2252)", async () => {
    const root = mkdtempSync(join(tmpdir(), "genesis-sup-seedfail-"));
    const sup = new Supervisor({
      defaultWorkspace: ws,
      run: fakeRunner("x"),
      stackSeeder: () => {
        throw new Error("disk full");
      },
    });
    const saved = await sup.registerWorkspace({ id: "ws-bad", name: "bad", rootPath: root });
    expect(saved.id).toBe("ws-bad");
    expect((await sup.listWorkspaces()).map((w) => w.id)).toContain("ws-bad");
  });

  // ── BRO-2260: turn admission bounds ────────────────────────────────────────
  //
  // Two dispatches on DIFFERENT threads are needed to exercise the gate at all:
  // same-thread turns are already serialized by the per-thread chain, so they can
  // never be concurrent and the gate would never see them.
  function blockingRunner(): {
    run: (o: any) => Promise<RunResult>;
    releaseAll: () => void;
    started: () => number;
  } {
    let started = 0;
    const gates: Array<() => void> = [];
    return {
      started: () => started,
      releaseAll: () => {
        for (const g of gates.splice(0)) g();
      },
      run: async () => {
        started++;
        await new Promise<void>((res) => gates.push(res));
        return {
          state: { phase: "done" as const, sessionId: `s-${started}`, lastText: "ok", turns: 1 },
          events: [],
          exitCode: 0,
        };
      },
    };
  }

  test("a second concurrent turn in the same workspace is refused (BRO-2260)", async () => {
    const r = blockingRunner();
    const sup = new Supervisor({
      defaultWorkspace: ws,
      run: r.run,
      concurrency: { perWorkspace: 1 },
    });
    const first = sup.dispatch("t-a", "one");
    await Bun.sleep(5);
    expect(r.started()).toBe(1);
    await expect(sup.dispatch("t-b", "two")).rejects.toThrow(/already have 1 turn running/i);
    r.releaseAll();
    await first;
  });

  // The POSITIVE half — a gate stuck closed would pass the test above.
  test("the slot is returned when the turn finishes, so the next one runs (BRO-2260)", async () => {
    const r = blockingRunner();
    const sup = new Supervisor({
      defaultWorkspace: ws,
      run: r.run,
      concurrency: { perWorkspace: 1 },
    });
    const first = sup.dispatch("t-a", "one");
    await Bun.sleep(5);
    r.releaseAll();
    await first;
    const second = sup.dispatch("t-b", "two");
    await Bun.sleep(5);
    r.releaseAll();
    expect((await second).reply).toBe("ok");
  });

  // The leak that would only show up as an outage much later: a turn that throws
  // must still give its slot back.
  test("a FAILING turn still releases its slot (BRO-2260)", async () => {
    let calls = 0;
    const sup = new Supervisor({
      defaultWorkspace: ws,
      concurrency: { perWorkspace: 1 },
      run: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return {
          state: { phase: "done" as const, sessionId: "s-2", lastText: "ok", turns: 1 },
          events: [],
          exitCode: 0,
        };
      },
    });
    await expect(sup.dispatch("t-a", "one")).rejects.toThrow("boom");
    expect((await sup.dispatch("t-b", "two")).reply).toBe("ok");
  });

  test("the global bound refuses across DIFFERENT workspaces (BRO-2260)", async () => {
    const r = blockingRunner();
    const sup = new Supervisor({
      defaultWorkspace: ws,
      run: r.run,
      workspaceExists: () => true,
      concurrency: { global: 1 },
    });
    await sup.registerWorkspace({ id: "ws-other", name: "other", rootPath: ws.rootPath });
    const first = sup.dispatch("t-a", "one");
    await Bun.sleep(5);
    await expect(
      sup.dispatch("t-b", "two", undefined, { workspaceId: "ws-other" }),
    ).rejects.toThrow(/capacity/i);
    r.releaseAll();
    await first;
  });

  test("unbounded by default — the pre-BRO-2260 behaviour is preserved", async () => {
    const r = blockingRunner();
    const sup = new Supervisor({ defaultWorkspace: ws, run: r.run });
    const a = sup.dispatch("t-a", "one");
    const b = sup.dispatch("t-b", "two");
    const c = sup.dispatch("t-c", "three");
    await Bun.sleep(5);
    expect(r.started()).toBe(3);
    r.releaseAll();
    await Promise.all([a, b, c]);
  });

  // Codex P20 major: a refusal must be FREE of side effects, or "just resend" is
  // a lie — the resend lands in a thread the refusal already corrupted.
  test("a refused turn records NO history and leaves the session untouched (BRO-2260)", async () => {
    const r = blockingRunner();
    const sup = new Supervisor({
      defaultWorkspace: ws,
      run: r.run,
      concurrency: { perWorkspace: 1 },
    });
    const first = sup.dispatch("t-a", "one");
    await Bun.sleep(5);
    await expect(sup.dispatch("t-b", "refused message")).rejects.toThrow(TurnRejectedError);

    // No user turn recorded for the refused thread.
    expect(await sup.history("t-b")).toEqual([]);
    // ...and it did not acquire a title from the message it never processed.
    const session = await sup.resolve("t-b");
    expect(session.title).toBeUndefined();
    expect(session.phase).toBe("idle");

    r.releaseAll();
    await first;
  });

  test("turn bounds are forwarded to the runner (BRO-2260)", async () => {
    let seen: { idleTimeoutMs?: number; maxTurnMs?: number } = {};
    const sup = new Supervisor({
      defaultWorkspace: ws,
      turnIdleTimeoutMs: 111,
      turnMaxMs: 222,
      run: async (o: any) => {
        seen = { idleTimeoutMs: o.idleTimeoutMs, maxTurnMs: o.maxTurnMs };
        return {
          state: { phase: "done" as const, sessionId: "s", lastText: "ok", turns: 1 },
          events: [],
          exitCode: 0,
        };
      },
    });
    await sup.dispatch("t-a", "go");
    expect(seen).toEqual({ idleTimeoutMs: 111, maxTurnMs: 222 });
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

describe("title generation (BRO-1665)", () => {
  test("sanitizeTitle strips quotes / 'Title:' / trailing punctuation, first line, caps length", () => {
    expect(sanitizeTitle('"Consensus Algorithms."')).toBe("Consensus Algorithms");
    expect(sanitizeTitle("Title: Raft vs Paxos")).toBe("Raft vs Paxos");
    expect(sanitizeTitle("Deploy pipeline fix\nignored second line")).toBe("Deploy pipeline fix");
    expect(sanitizeTitle("  spaced   out   title  ")).toBe("spaced out title");
    expect(sanitizeTitle("`code title`")).toBe("code title");
    // Control + format chars stripped (P20): a NUL (\x00) would throw in Postgres;
    // the bidi override (\u202E) could spoof the rendered title.
    expect(sanitizeTitle("ab\x00cd")).toBe("abcd");
    expect(sanitizeTitle("safe\u202Etxet")).toBe("safetxet");
    expect(sanitizeTitle("")).toBeUndefined();
    expect(sanitizeTitle(undefined)).toBeUndefined();
    expect(sanitizeTitle("   ")).toBeUndefined();
    // Over-long → capped with an ellipsis (code-point safe).
    const long = "a".repeat(80);
    expect([...(sanitizeTitle(long) ?? "")].length).toBe(61); // 60 + ellipsis
  });

  test("buildTitlePrompt inlines both sides (truncated) so the model needs no tools", () => {
    const p = buildTitlePrompt("x".repeat(1000), "y".repeat(1000));
    expect(p).toContain("Output ONLY the title");
    expect(p).toContain("do not use any tools");
    expect(p).toContain(`User: ${"x".repeat(600)}\n`); // user capped at 600
    expect(p).toContain(`Assistant: ${"y".repeat(400)}\n`); // reply capped at 400
    // A missing reply drops the Assistant line.
    expect(buildTitlePrompt("hi", "")).not.toContain("Assistant:");
  });

  test("generateTitleAsync upgrades the heuristic title via the print runner", async () => {
    const store = new InMemoryStore();
    // The print runner returns a messy title → exercises the sanitize path.
    const titleRunner = async (): Promise<RunResult> => ({
      state: { phase: "done", sessionId: "s", lastText: '"Consensus Algorithms."', turns: 1 },
      events: [],
      exitCode: 0,
    });
    const sup = new Supervisor({ defaultWorkspace: ws, store, run: titleRunner });
    const prompt = "Write a 1500-word essay comparing Paxos, Raft, and PBFT";
    await sup.dispatch("tt", prompt, undefined, {});
    // The instant heuristic is set on the first turn.
    expect((await store.findSessionByThread("tt"))?.title).toBe(deriveTitle(prompt));
    // Run the (normally fire-and-forget) title-gen deterministically.
    await (
      sup as unknown as { generateTitleAsync: (t: string, u: string, r: string) => Promise<void> }
    ).generateTitleAsync("tt", prompt, "some reply");
    expect((await store.findSessionByThread("tt"))?.title).toBe("Consensus Algorithms");
  });

  /**
   * The title spawn deliberately does not forward `this.extraArgs`, because those
   * carry permission flags and the title prompt inlines untrusted tenant text.
   * That same omission meant it did not forward `--strict-mcp-config` either, so
   * the spawn inherited the OPERATOR's MCP servers on a turn a tenant wrote.
   *
   * Asserted as a PAIR. "confined gets the flag" alone would also pass if the flag
   * were added unconditionally, which would silently confine the operator's own
   * threads; and neither case may reintroduce a permission flag.
   */
  test("the title spawn is MCP-confined when the workspace is, and not otherwise", async () => {
    async function argsForTitleSpawn(confined: boolean): Promise<string[] | undefined> {
      const store = new InMemoryStore();
      let seen: string[] | undefined;
      let called = false;
      const capturing = async (o: { extraArgs?: string[] }): Promise<RunResult> => {
        called = true;
        seen = o.extraArgs;
        return {
          state: { phase: "done", sessionId: "s", lastText: "A Title", turns: 1 },
          events: [],
          exitCode: 0,
        };
      };
      const workspace = { ...ws, confined };
      const sup = new Supervisor({
        defaultWorkspace: workspace,
        store,
        run: capturing,
        // The real agent's flags. The title spawn must never echo these back.
        extraArgs: ["--dangerously-skip-permissions"],
      });
      await sup.dispatch("t-mcp", "some question", undefined, {});
      seen = undefined;
      called = false;
      await (
        sup as unknown as { generateTitleAsync: (t: string, u: string, r: string) => Promise<void> }
      ).generateTitleAsync("t-mcp", "some question", "a reply");
      // A spawn that never happened would report `undefined` and read as a pass.
      expect(called).toBe(true);
      return seen;
    }

    const confined = await argsForTitleSpawn(true);
    expect(confined).toEqual(["--strict-mcp-config"]);

    const open = await argsForTitleSpawn(false);
    expect(open ?? []).not.toContain("--strict-mcp-config");

    // Neither polarity may leak the operator's permission flags into a prompt
    // that inlines tenant-authored text.
    for (const got of [confined, open]) {
      expect(got ?? []).not.toContain("--dangerously-skip-permissions");
    }
  });

  test("generateTitleAsync does NOT clobber a user-renamed title", async () => {
    const store = new InMemoryStore();
    const titleRunner = async (): Promise<RunResult> => ({
      state: { phase: "done", sessionId: "s", lastText: "LLM Generated Title", turns: 1 },
      events: [],
      exitCode: 0,
    });
    const sup = new Supervisor({ defaultWorkspace: ws, store, run: titleRunner });
    const prompt = "help me with something";
    await sup.dispatch("tr", prompt, undefined, {});
    // Simulate a user rename between the first turn and the title-gen completing.
    const renamed = await store.findSessionByThread("tr");
    if (renamed) {
      renamed.title = "My Own Title";
      await store.upsertSession(renamed);
    }
    await (
      sup as unknown as { generateTitleAsync: (t: string, u: string, r: string) => Promise<void> }
    ).generateTitleAsync("tr", prompt, "reply");
    // The rename wins — the LLM title must not overwrite it.
    expect((await store.findSessionByThread("tr"))?.title).toBe("My Own Title");
  });
});

describe("hardenedExtraArgs — confined workspaces drop inherited MCP (BRO-2224)", () => {
  test("a confined workspace ALWAYS gets --strict-mcp-config", () => {
    expect(hardenedExtraArgs({ confined: true })).toEqual(["--strict-mcp-config"]);
    expect(hardenedExtraArgs({ confined: true }, [])).toEqual(["--strict-mcp-config"]);
  });

  test("operator args are preserved, with the flag appended after them", () => {
    // Appended, not merged: the flag is boolean, so a later occurrence can only
    // add it. Nothing an operator puts in GENESIS_AGENT_ARGS can take it away.
    expect(hardenedExtraArgs({ confined: true }, ["--model=haiku"])).toEqual([
      "--model=haiku",
      "--strict-mcp-config",
    ]);
  });

  test("an unconfined workspace is UNCHANGED — the operator keeps their MCP", () => {
    expect(hardenedExtraArgs({}, ["--model=haiku"])).toEqual(["--model=haiku"]);
    expect(hardenedExtraArgs({ confined: false }, ["--model=haiku"])).toEqual(["--model=haiku"]);
    expect(hardenedExtraArgs({})).toBeUndefined();
  });

  test("absent `confined` is treated as UNCONFINED, so this cannot silently harden", () => {
    // Direction check. Hardening every workspace would strip MCP from the
    // operator's own Telegram and web sessions — a regression that looks like
    // "my Railway tools vanished", with no error naming this code.
    expect(hardenedExtraArgs({ confined: undefined }, ["x"])).toEqual(["x"]);
  });

  test("the input array is not mutated", () => {
    const operator = ["--model=haiku"];
    hardenedExtraArgs({ confined: true }, operator);
    expect(operator).toEqual(["--model=haiku"]);
  });
});

/**
 * BRO-2235 — HOME must travel on EVERY spawn a workspace causes, not just the turn.
 *
 * The title spawn is the one that gets forgotten: it is fire-and-forget, its output
 * is a string nobody inspects, and it already had this exact bug once for MCP
 * (--strict-mcp-config was omitted because `extraArgs` was deliberately not
 * forwarded). A title spawn left on the operator's HOME would run untrusted tenant
 * text against the operator's credential and skills — the same hole, one layer down.
 *
 * Asserted as a PAIR, for the reason the MCP test above gives: "set when provisioned"
 * alone would also pass if HOME were set unconditionally, which would point every
 * operator thread at a tenant directory.
 */
describe("per-tenant HOME travels on every spawn (BRO-2235)", () => {
  async function homeSeenBy(
    phase: "turn" | "title",
    home: string | undefined,
  ): Promise<{ called: boolean; home?: string }> {
    const store = new InMemoryStore();
    let seen: string | undefined;
    let called = false;
    const capturing = async (o: { home?: string }): Promise<RunResult> => {
      called = true;
      seen = o.home;
      return {
        state: { phase: "done", sessionId: "s", lastText: "A Title", turns: 1 },
        events: [],
        exitCode: 0,
      };
    };
    const sup = new Supervisor({
      defaultWorkspace: { ...ws, home },
      store,
      run: capturing,
    });
    await sup.dispatch("t-home", "a question", undefined, {});
    if (phase === "title") {
      seen = undefined;
      called = false;
      await (
        sup as unknown as { generateTitleAsync: (t: string, u: string, r: string) => Promise<void> }
      ).generateTitleAsync("t-home", "a question", "a reply");
    }
    return { called, home: seen };
  }

  test.each(["turn", "title"] as const)("%s spawn carries a provisioned home", async (phase) => {
    const r = await homeSeenBy(phase, "/tenants/573001112233/home");
    // A spawn that never happened would report `undefined` and read as a pass.
    expect(r.called).toBe(true);
    expect(r.home).toBe("/tenants/573001112233/home");
  });

  test.each(["turn", "title"] as const)("%s spawn leaves an unset home unset", async (phase) => {
    const r = await homeSeenBy(phase, undefined);
    expect(r.called).toBe(true);
    expect(r.home).toBeUndefined();
  });
});

/**
 * BRO-2235 — a declared HOME that cannot be delivered must REFUSE the turn.
 *
 * Three review rounds each found this same defect in a different cell: a relative
 * path, a non-print engine, a host whose env never reaches the child, and the title
 * spawn that bypassed the check. So the assertion is written over the MATRIX rather
 * than per-branch — a new engine or host is refused by default, and a test has to be
 * deliberately changed to make it pass.
 *
 * The line that matters: an UNSET home is not a request and proceeds (refusing would
 * turn a provisioning gap into an outage); anything else is a request that cannot be
 * honoured, and serving it unisolated hands a tenant the operator's credential while
 * looking like a normal turn.
 */
describe("homeRefusal (BRO-2235)", () => {
  const HOME = "/tenants/573/home";

  test("no home is not a request → never refuses, on any engine or host", () => {
    for (const e of ["print", "interactive", "codex", undefined]) {
      for (const h of ["local", "vps", "microvm", undefined]) {
        expect(homeRefusal({}, e, h)).toBeUndefined();
        expect(homeRefusal({ home: "   " }, e, h)).toBeUndefined();
      }
    }
  });

  test("the one deliverable combination is allowed", () =>
    expect(homeRefusal({ home: HOME }, "print", "local")).toBeUndefined());

  // THE BLOCKER a prior round found, and which a prior TEST asserted as correct:
  // `engineHomeRefusal` checked only the engine, so a relative home passed it and
  // then `tenantEnv` dropped the path and supplied the operator's HOME.
  test.each(["relative/home", "./home", "../home", "home"])(
    "a non-absolute home %p refuses instead of silently falling back",
    (home) => {
      expect(homeRefusal({ home }, "print", "local")).toMatch(/absolute path/);
    },
  );

  test.each(["interactive", "codex", "future-engine", undefined])(
    "engine %p does not carry HOME → refuses",
    (engine) => {
      expect(homeRefusal({ home: HOME }, engine, "local")).toMatch(/does not carry it/);
    },
  );

  // The host comment in packages/host/src/index.ts says it outright: ssh does not
  // forward arbitrary env, so a vps child keeps the REMOTE operator's HOME.
  test.each(["vps", "microvm", "future-host"])("host %p does not deliver HOME → refuses", (h) => {
    expect(homeRefusal({ home: HOME }, "print", h)).toMatch(/does not deliver it/);
  });

  test("hostKind omitted skips only the host clause — it never turns a refusal into a pass", () => {
    expect(homeRefusal({ home: HOME }, "print", undefined)).toBeUndefined();
    expect(homeRefusal({ home: "relative" }, "print", undefined)).toBeDefined();
    expect(homeRefusal({ home: HOME }, "interactive", undefined)).toBeDefined();
  });

  test("no refusal leaks the tenant path into a channel-visible message", () => {
    for (const [e, h] of [
      ["interactive", "local"],
      ["print", "vps"],
    ] as const) {
      expect(homeRefusal({ home: HOME }, e, h)).not.toContain(HOME);
    }
  });

  test("the dispatch actually refuses, and does not spawn", async () => {
    const store = new InMemoryStore();
    let spawned = false;
    const mark = async () => {
      spawned = true;
      return {
        state: { phase: "done" as const, sessionId: "s", lastText: "x", turns: 1 },
        events: [],
        exitCode: 0,
      };
    };
    const sup = new Supervisor({
      defaultWorkspace: { ...ws, home: HOME },
      store,
      run: mark,
      runners: { interactive: mark },
      defaultEngine: "interactive",
    });
    await expect(sup.dispatch("t-eng", "a question", undefined, {})).rejects.toThrow(
      /does not carry it/,
    );
    expect(spawned).toBe(false);
    const row = await store.findSessionByThread("t-eng");
    expect(row?.phase).not.toBe("running");
  });
});

/**
 * BRO-2235 — the guards must be UNDELETABLE, not merely present.
 *
 * Cross-model review (round 3, PASS) left one minor standing and it is the one that
 * matters given this branch's history: "no integration test would fail if the
 * post-lease or title guards were deleted." Every defect on this PR was a guard that
 * read correctly and did not hold, so a guard nothing asserts is exactly what must
 * not ship.
 *
 * These count LEASES and SPAWNS through a fake provider, so each guard's deletion is
 * observable rather than inferred:
 *   - pre-lease refusal  -> zero leases taken (it must refuse before spending a host)
 *   - post-lease refusal -> the lease it abandoned is RELEASED (no leak)
 *   - title refusal      -> `runners.print` is never invoked
 */
describe("HOME guards are observable, not just present (BRO-2235)", () => {
  const HOME = "/tenants/573/home";

  class CountingProvider {
    leases = 0;
    releases = 0;
    constructor(private readonly kind: "local" | "vps" = "local") {}
    async resolveHost() {
      this.leases++;
      // Only `host.kind` is read before the guard fires, so a stub is honest here —
      // a real host would add failure modes the guard is not the subject of.
      const host = { kind: this.kind } as unknown as ExecutionHost;
      return { host, release: async () => void this.releases++ };
    }
  }

  const spawnCounter = () => {
    let calls = 0;
    const run = async () => {
      calls++;
      return {
        state: { phase: "done" as const, sessionId: "s", lastText: "A Title", turns: 1 },
        events: [],
        exitCode: 0,
      };
    };
    return { run, calls: () => calls };
  };

  test("PRE-LEASE refusal (bad engine) spends no host at all", async () => {
    const provider = new CountingProvider();
    const spawn = spawnCounter();
    const sup = new Supervisor({
      defaultWorkspace: { ...ws, home: HOME },
      store: new InMemoryStore(),
      run: spawn.run,
      runners: { interactive: spawn.run },
      defaultEngine: "interactive",
      hostProvider: provider,
    });
    await expect(sup.dispatch("t-nolease", "q", undefined, {})).rejects.toThrow(/does not carry/);
    expect(provider.leases).toBe(0); // deleting the pre-lease guard makes this 1
    expect(spawn.calls()).toBe(0);
  });

  test("POST-LEASE refusal (bad host) releases the lease it abandoned", async () => {
    const provider = new CountingProvider("vps");
    const spawn = spawnCounter();
    const sup = new Supervisor({
      defaultWorkspace: { ...ws, home: HOME },
      store: new InMemoryStore(),
      run: spawn.run,
      hostProvider: provider,
    });
    await expect(sup.dispatch("t-vps", "q", undefined, {})).rejects.toThrow(/does not deliver it/);
    expect(provider.leases).toBe(1); // the host clause needs the lease to be known
    expect(provider.releases).toBe(1); // ...and must not leak it
    expect(spawn.calls()).toBe(0); // deleting the host guard makes this 1
  });

  // A SESSION MUST EXIST for the title path to reach the guard — `generateTitleAsync`
  // returns early on `!session`. The first version of this test called it on a thread
  // that had never dispatched, so it exited before the guard and the deletability
  // sweep reported the guard SURVIVED. The sweep caught the vacuity; the test did not.
  test("TITLE refusal never reaches the print runner", async () => {
    const store = new InMemoryStore();
    const spawn = spawnCounter();

    // Turn 1: no home, local host -> succeeds, creating the session + its row.
    const first = new Supervisor({
      defaultWorkspace: { ...ws },
      store,
      run: spawn.run,
      hostProvider: new CountingProvider("local"),
    });
    await first.dispatch("t-title-guard", "untrusted tenant text", undefined, {});
    const spawnsAfterTurn = spawn.calls();
    expect(spawnsAfterTurn).toBeGreaterThan(0); // the session really exists

    // Now the same thread is titled by a supervisor whose workspace DOES declare a
    // home, on a host that cannot deliver it — the case the title guard exists for.
    const titler = new Supervisor({
      defaultWorkspace: { ...ws, home: HOME },
      store,
      run: spawn.run,
      hostProvider: new CountingProvider("vps"),
    });
    // HYDRATE THE REGISTRY FIRST. `loadRegistry` is async and runs on dispatch, so a
    // supervisor that has never dispatched still has an EMPTY registry — which made
    // the strict-resolution check return before the home guard, and the deletability
    // sweep correctly reported the guard SURVIVED. Without this line the test passes
    // for the wrong reason.
    await titler.listWorkspaces();
    await (
      titler as unknown as {
        generateTitleAsync: (t: string, u: string, r: string) => Promise<void>;
      }
    ).generateTitleAsync("t-title-guard", "untrusted tenant text", "a reply");

    // Deleting the title guard makes this spawn, titling tenant text under the
    // operator's HOME.
    expect(spawn.calls()).toBe(spawnsAfterTurn);
  });
});
