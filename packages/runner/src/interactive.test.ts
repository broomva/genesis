// Interactive engine tests — a scripted FakeHub emits IR sequences and the
// engine must fold them into the same RunResult contract the print engine
// produces (the Supervisor cannot tell the engines apart).

import { describe, expect, test } from "bun:test";
import { reduceAll } from "@genesis/projection";
import type { IREvent } from "@genesis/session-host";
import { type EngineHub, type EngineSession, createInteractiveEngine } from "./interactive";

type Listener = (e: IREvent) => void;

class FakeSession implements EngineSession {
  sent: string[] = [];
  killed = false;
  interrupted = 0;
  drained = 0;
  constructor(
    public sessionId: string,
    private deliver: (sessionId: string) => void,
    /** Emits transcript-only content (e.g. thinking) the way the real tailer
     *  does when flushed — used to exercise the BRO-1616 drain. */
    private onDrain?: (sessionId: string) => void,
  ) {}
  async send(text: string): Promise<void> {
    this.sent.push(text);
    this.deliver(this.sessionId);
  }
  async interrupt(): Promise<void> {
    this.interrupted += 1;
  }
  async alive(): Promise<boolean> {
    return !this.killed;
  }
  async kill(): Promise<void> {
    this.killed = true;
  }
  async drainTranscript(): Promise<void> {
    this.drained += 1;
    this.onDrain?.(this.sessionId);
  }
}

class FakeHub implements EngineHub {
  listeners = new Set<Listener>();
  sessions: FakeSession[] = [];
  createCalls = 0;
  stopped = false;
  /** Script: IR events (minus sessionId) emitted after each spawn/send.
   *  `drainScript` (optional): transcript-only events the engine pulls in when it
   *  flushes the transcript at turn.complete (BRO-1616). */
  constructor(
    private script: (sessionId: string) => IREvent[],
    private drainScript?: (sessionId: string) => IREvent[],
  ) {}

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
    // Default drain mirrors reality: the transcript always receives the assistant
    // entry shortly after turn.complete, which ends the engine's bounded drain
    // loop (BRO-1616). Tests that exercise thinking override with their own script.
    const drainScript =
      this.drainScript ??
      ((sid: string): IREvent[] => [
        {
          sessionId: sid,
          observedAt: 1,
          surface: "transcript",
          kind: "message.assistant",
          text: "",
        },
      ]);
    const onDrain = (sid: string) => {
      for (const e of drainScript(sid)) this.emit(e);
    };
    const session = new FakeSession(id, (sid) => this.playScript(sid), onDrain);
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
    {
      ...base(sessionId),
      kind: "tool.use",
      toolUseId: `tu-${marker}`,
      name: "Bash",
      input: { command: `echo ${marker}` },
    },
    {
      ...base(sessionId),
      kind: "tool.result",
      toolUseId: `tu-${marker}`,
      content: { stdout: marker },
      isError: false,
    },
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

  test("flushes transcript-only thinking at turn.complete → reasoned + reasoning (BRO-1616)", async () => {
    // Hook surface carries the answer + turn.complete but NOT the thinking —
    // extended-thinking is transcript-only and the Stop hook outpaces the tailer.
    // It lands only when the engine flushes the transcript at turn.complete.
    const hookTurn = (sid: string): IREvent[] => [
      { ...base(sid), kind: "session.lifecycle", phase: "ready", transcriptPath: "/t.jsonl" },
      {
        ...base(sid),
        kind: "message.assistant",
        text: "The answer is 33.",
        messageId: "m1",
        streaming: { final: true },
      },
      { ...base(sid), kind: "turn.complete", lastAssistantMessage: "The answer is 33." },
    ];
    // The drain delivers the late-written transcript entries: the thinking block
    // FOLLOWED by the assistant message (the order claude writes them). The
    // assistant message ends the bounded drain-retry loop.
    const drainTurn = (sid: string): IREvent[] => [
      {
        sessionId: sid,
        observedAt: 1,
        surface: "transcript",
        kind: "thinking",
        text: "I used inclusion-exclusion: 99 − 66 = 33.",
      },
      {
        sessionId: sid,
        observedAt: 1,
        surface: "transcript",
        kind: "message.assistant",
        text: "The answer is 33.",
        messageId: "m1",
      },
    ];
    const hub = new FakeHub(hookTurn, drainTurn);
    const engine = createInteractiveEngine({ hub });
    const result = await engine.run({
      prompt: "count",
      cwd: "/x",
      worktree: false,
      sessionKey: "sr",
    });
    expect(hub.sessions[0]?.drained).toBeGreaterThan(0); // the engine flushed at turn.complete
    expect(result.state.reasoned).toBe(true);
    expect(result.state.reasoning ?? "").toContain("inclusion-exclusion");
    await engine.shutdown();
  });

  test("a no-thinking turn drains the assistant entry but stays not-reasoned (BRO-1616)", async () => {
    // The drain delivers the late assistant entry but NO thinking sibling (adaptive
    // thinking skipped a trivial turn). The loop terminates on the assistant entry;
    // reasoned stays false. Guards that capture is thinking-specific, not "any drain".
    const hookTurn = (sid: string): IREvent[] => [
      { ...base(sid), kind: "session.lifecycle", phase: "ready", transcriptPath: "/t.jsonl" },
      {
        ...base(sid),
        kind: "message.assistant",
        text: "4.",
        messageId: "m1",
        streaming: { final: true },
      },
      { ...base(sid), kind: "turn.complete", lastAssistantMessage: "4." },
    ];
    const drainTurn = (sid: string): IREvent[] => [
      {
        sessionId: sid,
        observedAt: 1,
        surface: "transcript",
        kind: "message.assistant",
        text: "4.",
      },
    ];
    const hub = new FakeHub(hookTurn, drainTurn);
    const engine = createInteractiveEngine({ hub });
    const result = await engine.run({
      prompt: "2+2",
      cwd: "/x",
      worktree: false,
      sessionKey: "sr2",
    });
    expect(result.state.reasoned).toBeFalsy();
    expect(result.state.reasoning ?? "").toBe("");
    await engine.shutdown();
  });

  test("tool ids flow through → a BUILT + FILLED tool part (BRO-1613 S2)", async () => {
    const hub = new FakeHub((sid) => happyTurn(sid, "alpha"));
    const engine = createInteractiveEngine({ hub });
    const result = await engine.run({
      prompt: "x",
      cwd: "/x",
      worktree: false,
      sessionKey: "sp",
    });
    const tools = (result.state.parts ?? []).filter((p) => p.type === "tool");
    expect(tools).toHaveLength(1); // built (id present) — empty if the id passthrough regressed
    expect(tools[0]).toMatchObject({ toolName: "Bash", state: "output-available" }); // filled by the result
    await engine.shutdown();
  });

  test("multi-turn cost is a per-turn DELTA, not the cumulative statusline total (BRO-1613 P20 B1)", async () => {
    let turn = 0;
    const hub = new FakeHub((sid) => {
      turn += 1;
      const cumulative = 0.1 * turn; // statusline reports CUMULATIVE session cost
      return [
        { ...base(sid), kind: "session.lifecycle", phase: "ready", transcriptPath: "/t" },
        {
          sessionId: sid,
          observedAt: 1,
          surface: "statusline",
          kind: "status",
          costUsd: cumulative,
          raw: {},
        },
        { ...base(sid), kind: "turn.complete", lastAssistantMessage: "ok" },
      ];
    });
    const engine = createInteractiveEngine({ hub });
    const opts = { cwd: "/x", worktree: false as const, sessionKey: "sc" };
    const r1 = await engine.run({ ...opts, prompt: "one" });
    const r2 = await engine.run({ ...opts, prompt: "two" });
    expect(r1.state.costUsd).toBeCloseTo(0.1); // turn 1: 0.10 − 0
    expect(r2.state.costUsd).toBeCloseTo(0.1); // turn 2 DELTA: 0.20 − 0.10 (NOT the cumulative 0.20)
    await engine.shutdown();
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

  test("a throwing send() kills + evicts the session (closed-loop B1)", async () => {
    const hub = new FakeHub((sid) => happyTurn(sid, "zeta"));
    const engine = createInteractiveEngine({ hub });
    const opts = { cwd: "/x", worktree: false as const, sessionKey: "s11" };
    const r1 = await engine.run({ ...opts, prompt: "one" });
    expect(r1.state.phase).toBe("done");

    // Simulate an unacknowledged send (closed-loop send exhausted retries).
    const session = hub.sessions[0];
    if (!session) throw new Error("no session");
    session.send = async () => {
      throw new Error("send() not acknowledged by UserPromptSubmit after 3 attempts");
    };
    const r2 = await engine.run({ ...opts, prompt: "two" });
    expect(r2.state.phase).toBe("blocked");
    expect(session.killed).toBe(true); // poisoned session reaped, not reused

    const r3 = await engine.run({ ...opts, prompt: "three" });
    expect(hub.createCalls).toBe(2); // respawned fresh
    expect(r3.state.phase).toBe("done");
    await engine.shutdown();
  });

  test("slash command short-circuits with a reply, never spawning a session (BRO-1485 #10)", async () => {
    const hub = new FakeHub(() => []); // would hang if a session were created
    const engine = createInteractiveEngine({ hub });
    const states: string[] = [];
    const result = await engine.run({
      prompt: "/model",
      cwd: "/x",
      worktree: false,
      sessionKey: "s12",
      onState: (st) => states.push(st.phase),
    });
    expect(result.state.phase).toBe("done");
    expect(result.state.lastText).toContain("model");
    expect(result.exitCode).toBe(0);
    expect(hub.createCalls).toBe(0); // session NEVER touched
    expect(states).toEqual(["done"]);
    await engine.shutdown();
  });

  test("a normal prompt after a slash command still spawns and runs", async () => {
    const hub = new FakeHub((sid) => happyTurn(sid, "eta"));
    const engine = createInteractiveEngine({ hub });
    const opts = { cwd: "/x", worktree: false as const, sessionKey: "s13" };
    const r1 = await engine.run({ ...opts, prompt: "/clear" });
    expect(r1.state.phase).toBe("done");
    expect(hub.createCalls).toBe(0);
    const r2 = await engine.run({ ...opts, prompt: "do real work" });
    expect(r2.state.phase).toBe("done");
    expect(hub.createCalls).toBe(1); // the real prompt spawns
    expect(r2.state.lastText).toContain("eta");
    await engine.shutdown();
  });

  test("slash intercept reuses an EXISTING live session id without touching it (P20 #4)", async () => {
    const hub = new FakeHub((sid) => happyTurn(sid, "theta"));
    const engine = createInteractiveEngine({ hub });
    const opts = { cwd: "/x", worktree: false as const, sessionKey: "s14" };
    // Turn 1: real prompt → spawns a live session.
    const r1 = await engine.run({ ...opts, prompt: "real work" });
    expect(hub.createCalls).toBe(1);
    const liveId = r1.state.sessionId;
    // Turn 2: a slash command must reuse that session's id, not mint a phantom,
    // and must NOT spawn or send.
    const sentBefore = hub.sessions[0]?.sent.length ?? 0;
    const r2 = await engine.run({ ...opts, prompt: "/model" });
    expect(r2.state.phase).toBe("done");
    expect(r2.state.sessionId).toBe(liveId); // reused, not random
    expect(hub.createCalls).toBe(1); // no new spawn
    expect(hub.sessions[0]?.sent.length).toBe(sentBefore); // no send
    await engine.shutdown();
  });

  test("the synthetic slash result survives a reducer replay as done, not blocked (P20 #2)", () => {
    // The engine hand-builds state, but pin the contract: replaying the event
    // through the reducer must NOT invert to blocked (subtype must be success).
    const replayed = reduceAll([
      { type: "result", subtype: "success", session_id: "x", result: "⚠️ /model …" },
    ]);
    expect(replayed.phase).toBe("done");
  });

  test("control: reset kills + evicts a live session (fresh context next turn)", async () => {
    const hub = new FakeHub((sid) => happyTurn(sid, "ctl1"));
    const engine = createInteractiveEngine({ hub });
    const opts = { cwd: "/x", worktree: false as const, sessionKey: "c1" };
    await engine.run({ ...opts, prompt: "hello" });
    expect(await engine.reset("c1")).toBe(true);
    expect(hub.sessions[0]?.killed).toBe(true);
    // gone → reset again is a no-op
    expect(await engine.reset("c1")).toBe(false);
    // next turn respawns fresh
    await engine.run({ ...opts, prompt: "again" });
    expect(hub.createCalls).toBe(2);
    await engine.shutdown();
  });

  test("control: reset DURING an active turn resolves it blocked (not a 10-min hang, B1)", async () => {
    // A turn that never completes on its own (no terminal IR).
    const hub = new FakeHub(() => []);
    const engine = createInteractiveEngine({ hub, turnTimeoutMs: 600_000 });
    const opts = { cwd: "/x", worktree: false as const, sessionKey: "cb1" };
    let resolved: { phase: string } | undefined;
    const runP = engine.run({ ...opts, prompt: "long-running" }).then((r) => {
      resolved = { phase: r.state.phase };
      return r;
    });
    // Let the turn get in-flight (session created, parked on turnDone).
    await Bun.sleep(20);
    expect(resolved).toBeUndefined(); // still running
    // Reset mid-turn must abort it promptly — NOT wait for the 600s timeout.
    const start = Date.now();
    expect(await engine.reset("cb1")).toBe(true);
    const r = await runP;
    expect(Date.now() - start).toBeLessThan(2_000); // resolved fast, not on timeout
    expect(r.state.phase).toBe("blocked");
    expect(hub.sessions[0]?.killed).toBe(true);
    await engine.shutdown();
  });

  test("control: interrupt sends Escape to the live session", async () => {
    const hub = new FakeHub((sid) => happyTurn(sid, "ctl2"));
    const engine = createInteractiveEngine({ hub });
    const opts = { cwd: "/x", worktree: false as const, sessionKey: "c2" };
    expect(await engine.interrupt("c2")).toBe(false); // no session yet
    await engine.run({ ...opts, prompt: "work" });
    expect(await engine.interrupt("c2")).toBe(true);
    expect(hub.sessions[0]?.interrupted).toBe(1);
    await engine.shutdown();
  });

  test("control: status reports liveness + sessionId", async () => {
    const hub = new FakeHub((sid) => happyTurn(sid, "ctl3"));
    const engine = createInteractiveEngine({ hub });
    const opts = { cwd: "/x", worktree: false as const, sessionKey: "c3" };
    expect(await engine.status("c3")).toEqual({ alive: false });
    const r = await engine.run({ ...opts, prompt: "x" });
    const st = await engine.status("c3");
    expect(st.alive).toBe(true);
    expect(st.sessionId).toBe(r.state.sessionId);
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
