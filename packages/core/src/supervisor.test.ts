import { describe, expect, test } from "bun:test";
import type { RunResult } from "@genesis/runner";
import { Supervisor } from "./supervisor";

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
