// Interactive engine tests — a scripted FakeHub emits IR sequences and the
// engine must fold them into the same RunResult contract the print engine
// produces (the Supervisor cannot tell the engines apart).

import { describe, expect, test } from "bun:test";
import type { IREvent } from "@genesis/session-host";
import { type EngineHub, type EngineSession, createInteractiveEngine } from "./interactive";

type Listener = (e: IREvent) => void;

class FakeSession implements EngineSession {
  sent: string[] = [];
  killed = false;
  constructor(
    public sessionId: string,
    private deliver: (sessionId: string) => void,
  ) {}
  async send(text: string): Promise<void> {
    this.sent.push(text);
    this.deliver(this.sessionId);
  }
  async alive(): Promise<boolean> {
    return !this.killed;
  }
  async kill(): Promise<void> {
    this.killed = true;
  }
}

class FakeHub implements EngineHub {
  listeners = new Set<Listener>();
  sessions: FakeSession[] = [];
  createCalls = 0;
  stopped = false;
  /** Script: IR events (minus sessionId) emitted after each spawn/send. */
  constructor(private script: (sessionId: string) => IREvent[]) {}

  start(): void {}
  async stop(): Promise<void> {
    this.stopped = true;
  }
  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async createSession(opts: { sessionId?: string; initialPrompt?: string }): Promise<FakeSession> {
    this.createCalls += 1;
    const id = opts.sessionId ?? "fake-session";
    const session = new FakeSession(id, (sid) => this.playScript(sid));
    this.sessions.push(session);
    if (opts.initialPrompt !== undefined) this.playScript(id);
    return session;
  }
  private playScript(sessionId: string): void {
    // Async like the real hub (hook posts arrive after the call returns).
    setTimeout(() => {
      for (const e of this.script(sessionId)) {
        for (const l of this.listeners) l(e);
      }
    }, 5);
  }
  emit(e: IREvent): void {
    for (const l of this.listeners) l(e);
  }
}

const base = (sessionId: string) => ({ sessionId, observedAt: 1, surface: "hook" }) as const;

function happyTurn(sessionId: string, marker: string): IREvent[] {
  return [
    { ...base(sessionId), kind: "session.lifecycle", phase: "ready", transcriptPath: "/t.jsonl" },
    { ...base(sessionId), kind: "message.user", text: `say ${marker}` },
    { ...base(sessionId), kind: "tool.use", name: "Bash", input: { command: `echo ${marker}` } },
    { ...base(sessionId), kind: "tool.result", content: { stdout: marker }, isError: false },
    {
      ...base(sessionId),
      kind: "message.assistant",
      text: `The output is ${marker}`,
      messageId: "m1",
    },
    {
      ...base(sessionId),
      kind: "message.assistant",
      text: " — done.",
      messageId: "m1",
      streaming: { final: true },
    },
    {
      ...base(sessionId),
      kind: "turn.complete",
      lastAssistantMessage: `The output is ${marker} — done.`,
    },
  ];
}

describe("createInteractiveEngine", () => {
  test("happy turn folds IR into a done RunResult with the print-engine contract", async () => {
    const hub = new FakeHub((sid) => happyTurn(sid, "alpha"));
    const engine = createInteractiveEngine({ hub });
    const states: string[] = [];
    const result = await engine.run({
      prompt: "say alpha",
      cwd: "/nonexistent-not-a-repo",
      worktree: false,
      sessionKey: "s1",
      onState: (s) => states.push(s.phase),
    });
    expect(result.state.phase).toBe("done");
    expect(result.state.lastText).toBe("The output is alpha — done.");
    expect(result.worktreePersistent).toBe(true);
    expect(result.exitCode).toBe(0);
    // Streaming deltas accumulated: interim assistant event then full text.
    const texts = result.events
      .filter((e) => e.type === "assistant")
      .flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : []))
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    expect(texts).toContain("The output is alpha");
    expect(texts).toContain("The output is alpha — done.");
    expect(states.at(-1)).toBe("done");
    await engine.shutdown();
    expect(hub.stopped).toBe(true);
  });

  test("second dispatch on the same key reuses the live session (send, not spawn)", async () => {
    const hub = new FakeHub((sid) => happyTurn(sid, "beta"));
    const engine = createInteractiveEngine({ hub });
    const opts = { cwd: "/x", worktree: false as const, sessionKey: "s2" };
    await engine.run({ ...opts, prompt: "turn one" });
    const result2 = await engine.run({ ...opts, prompt: "turn two" });
    expect(hub.createCalls).toBe(1); // ONE persistent session
    expect(hub.sessions[0]?.sent).toEqual(["turn two"]); // 2nd turn via send()
    expect(result2.state.phase).toBe("done");
    await engine.shutdown();
  });

  test("a dead session is respawned with a FRESH sessionId (registry collision guard)", async () => {
    const hub = new FakeHub((sid) => happyTurn(sid, "gamma"));
    const engine = createInteractiveEngine({ hub });
    const opts = { cwd: "/x", worktree: false as const, sessionKey: "s3" };
    const r1 = await engine.run({ ...opts, prompt: "one" });
    await hub.sessions[0]?.kill();
    const r2 = await engine.run({ ...opts, prompt: "two" });
    expect(hub.createCalls).toBe(2);
    expect(r2.state.sessionId).not.toBe(r1.state.sessionId);
    await engine.shutdown();
  });

  test("turn timeout marks the run blocked, not stuck running", async () => {
    const hub = new FakeHub(() => []); // never completes
    const engine = createInteractiveEngine({ hub, turnTimeoutMs: 60 });
    const result = await engine.run({
      prompt: "hang forever",
      cwd: "/x",
      worktree: false,
      sessionKey: "s4",
    });
    expect(result.state.phase).toBe("blocked");
    expect(result.exitCode).toBe(1);
    await engine.shutdown();
  });

  test("a timed-out turn kills + evicts the session; next turn respawns fresh (B1)", async () => {
    let plays = 0;
    const hub = new FakeHub((sid) => {
      plays += 1;
      // First play (the turn that times out): never completes.
      // Second play (after respawn): a normal happy turn.
      return plays === 1 ? [] : happyTurn(sid, "delta");
    });
    const engine = createInteractiveEngine({ hub, turnTimeoutMs: 60 });
    const opts = { cwd: "/x", worktree: false as const, sessionKey: "s8" };

    const r1 = await engine.run({ ...opts, prompt: "hangs" });
    expect(r1.state.phase).toBe("blocked");
    // The busy session was killed and evicted — NOT left for reuse.
    expect(hub.sessions[0]?.killed).toBe(true);

    const r2 = await engine.run({ ...opts, prompt: "works" });
    expect(hub.createCalls).toBe(2); // respawned, not reused
    expect(r2.state.sessionId).not.toBe(r1.state.sessionId); // stale-event filter exact
    expect(r2.state.phase).toBe("done");
    expect(r2.state.lastText).toContain("delta");
    await engine.shutdown();
  });

  test("error IR kind marks the run blocked", async () => {
    const hub = new FakeHub((sid) => [{ ...base(sid), kind: "error", message: "boom" }]);
    const engine = createInteractiveEngine({ hub });
    const result = await engine.run({ prompt: "x", cwd: "/x", worktree: false, sessionKey: "s9" });
    expect(result.state.phase).toBe("blocked");
    expect(result.exitCode).toBe(1);
    await engine.shutdown();
  });

  test("shutdown kills live sessions and leaves no subscriptions behind", async () => {
    const hub = new FakeHub((sid) => happyTurn(sid, "epsilon"));
    const engine = createInteractiveEngine({ hub });
    await engine.run({ prompt: "x", cwd: "/x", worktree: false, sessionKey: "s10" });
    expect(hub.listeners.size).toBe(0); // per-turn subscription reclaimed
    expect(hub.sessions[0]?.killed).toBe(false); // persistent between turns
    await engine.shutdown();
    expect(hub.sessions[0]?.killed).toBe(true); // reaped at shutdown
    expect(hub.stopped).toBe(true);
  });

  test("AskUserQuestion gates the run awaiting (HITL preserved through translation)", async () => {
    const hub = new FakeHub((sid) => [
      {
        ...base(sid),
        kind: "tool.use",
        name: "AskUserQuestion",
        input: { questions: [{ question: "Which option?" }] },
      },
    ]); // NO turn.complete — interactive TUI is showing the dialog (no Stop fires)
    const engine = createInteractiveEngine({ hub, turnTimeoutMs: 5_000 });
    const start = Date.now();
    const result = await engine.run({
      prompt: "do a thing",
      cwd: "/x",
      worktree: false,
      sessionKey: "s5",
    });
    // Returns awaiting PROMPTLY (not via the timeout) with the session ALIVE
    // for the answer turn (CodeRabbit #9-2).
    expect(Date.now() - start).toBeLessThan(4_000);
    expect(result.state.phase).toBe("awaiting");
    expect(result.state.pendingQuestion).toBe("Which option?");
    expect(hub.sessions[0]?.killed).toBe(false);
    await engine.shutdown();
  });

  test("microVM hosts are rejected at the engine boundary", async () => {
    const hub = new FakeHub(() => []);
    const engine = createInteractiveEngine({ hub });
    const microHost = {
      kind: "microvm",
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      spawnStream: () => {
        throw new Error("unused");
      },
    };
    await expect(
      engine.run({
        prompt: "x",
        cwd: "/x",
        sessionKey: "s6",
        host: microHost as unknown as import("@genesis/host").ExecutionHost,
      }),
    ).rejects.toThrow(/local-host only.*microvm/);
    await engine.shutdown();
  });

  test("transcript-surface assistant events are ignored (no double-emit)", async () => {
    const hub = new FakeHub((sid) => [
      { ...base(sid), kind: "message.assistant", text: "hook text", messageId: "m1" },
      {
        sessionId: sid,
        observedAt: 1,
        surface: "transcript",
        kind: "message.assistant",
        text: "transcript text",
        messageId: "m1",
      },
      { ...base(sid), kind: "turn.complete", lastAssistantMessage: "hook text" },
    ]);
    const engine = createInteractiveEngine({ hub });
    const result = await engine.run({
      prompt: "x",
      cwd: "/x",
      worktree: false,
      sessionKey: "s7",
    });
    const texts = result.events
      .filter((e) => e.type === "assistant")
      .flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : []))
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    expect(texts).toEqual(["hook text"]);
    await engine.shutdown();
  });
});
