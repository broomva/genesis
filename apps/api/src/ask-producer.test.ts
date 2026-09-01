// The ask log's PRODUCER, end to end (BRO-2413).
//
// DoD 1 requires "an AskUserQuestion in a real session produces a line in
// asks.jsonl — asserted end to end, not by calling `append` in a test". So these
// drive a real Supervisor through a real dispatch into a real createAskLog, and
// read the result back with readAsks. Nothing here calls `append`.
//
// That distinction is not pedantry. Before this, `append` had 25 test call sites
// and zero production ones, and every one of them passed while the routes
// answered `{"asks":[]}` in every real deploy.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor } from "@genesis/core";
import type { AgentEvent, RunState } from "@genesis/projection";
import { ASK_FILE, type Ask, createAskLog, readAsks } from "./ask-log";

const ws = { id: "ws-1", name: "w", rootPath: "/tmp" };

/** An assistant message raising one AskUserQuestion, in the SDK's wire shape. */
const askEvent = (id: string, questions: unknown[]): AgentEvent =>
  ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions } }] },
  }) as unknown as AgentEvent;

const awaiting: RunState = {
  phase: "awaiting",
  sessionId: "s-1",
  lastText: "",
  turns: 1,
} as RunState;
const done: RunState = { phase: "done", sessionId: "s-1", lastText: "ok", turns: 1 } as RunState;

/** A runner that emits the given events through onState, then finishes. */
const runnerEmitting = (...events: [RunState, AgentEvent][]) =>
  // biome-ignore lint/suspicious/noExplicitAny: the harness shape the sibling suite uses
  (async (o: any) => {
    for (const [state, event] of events) o.onState?.(state, event);
    return { state: done, events: [], exitCode: 0 };
  }) as never;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "producer-"));
  const log = createAskLog(dir);
  return { dir, log, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("the producer writes an ask when a turn blocks on a human", () => {
  test("an AskUserQuestion in a dispatched turn lands in asks.jsonl", async () => {
    const { dir, log, cleanup } = harness();
    try {
      const sup = new Supervisor({
        defaultWorkspace: ws,
        onAsk: (a: Ask) => log.append(a),
        run: runnerEmitting([
          awaiting,
          askEvent("toolu_01", [
            {
              question: "Ship or hold?",
              header: "Deploy",
              options: [{ label: "ship", description: "now" }, { label: "hold" }],
            },
          ]),
        ]),
      } as never);
      await sup.dispatch("t1", "do it");

      const { entries } = readAsks(dir);
      expect(entries).toHaveLength(1);
      const [e] = entries;
      expect(e?.id).toBe("toolu_01");
      expect(e?.question).toBe("Ship or hold?");
      expect(e?.header).toBe("Deploy");
      expect(e?.threadId).toBe("t1");
      expect(e?.status).toBe("pending");
      // Options survive the round trip, including the optional description.
      expect(e?.options).toEqual([{ label: "ship", description: "now" }, { label: "hold" }]);
      // sessionId is the SUPERVISOR's session, not the agent's — the ask has to
      // be routable back to the thread that raised it.
      expect(e?.sessionId).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  test("a turn that never blocks writes NOTHING — the negative control", async () => {
    // Without this, a producer that appended on every event would pass the test
    // above and flood the log.
    const { dir, log, cleanup } = harness();
    try {
      const sup = new Supervisor({
        defaultWorkspace: ws,
        onAsk: (a: Ask) => log.append(a),
        run: runnerEmitting([done, { type: "result", subtype: "success" } as AgentEvent]),
      } as never);
      await sup.dispatch("t1", "do it");
      expect(readAsks(dir).entries).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("THE EDGE: further events while still awaiting do not re-append", async () => {
    // `onState` fires per event. Emitting whenever the phase IS "awaiting" would
    // append the same ask again for every subsequent event of a blocked turn —
    // on an append-only journal nothing compacts.
    const { dir, log, cleanup } = harness();
    try {
      const ask = askEvent("toolu_01", [{ question: "Ship or hold?" }]);
      const sup = new Supervisor({
        defaultWorkspace: ws,
        onAsk: (a: Ask) => log.append(a),
        run: runnerEmitting([awaiting, ask], [awaiting, ask], [awaiting, ask]),
      } as never);
      await sup.dispatch("t1", "do it");

      // ASSERTED ON THE JOURNAL, not on readAsks. The read side dedupes by
      // (threadId, id), so three appends of the same ask collapse to one entry
      // and `entries.toHaveLength(1)` passes whether or not the edge check
      // exists — which is exactly what happened: the mutant that removes
      // `!wasAwaiting` SURVIVED this test until it counted lines. A projection
      // that repairs the defect cannot be used to detect it.
      const lines = readFileSync(join(dir, ASK_FILE), "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(readAsks(dir).entries).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("several questions in ONE tool call become several asks, distinctly", async () => {
    const { dir, log, cleanup } = harness();
    try {
      const sup = new Supervisor({
        defaultWorkspace: ws,
        onAsk: (a: Ask) => log.append(a),
        run: runnerEmitting([
          awaiting,
          askEvent("toolu_01", [{ question: "First?" }, { question: "Second?" }]),
        ]),
      } as never);
      await sup.dispatch("t1", "do it");
      const { entries } = readAsks(dir);
      // Two asks, two ids. Collapsing them (as the projection's one-line summary
      // does, joining with " | ") would hand the operator one blob to answer.
      expect(entries.map((e) => e.question).sort()).toEqual(["First?", "Second?"]);
      expect(new Set(entries.map((e) => e.id)).size).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("a throwing producer does not fail the turn", async () => {
    // Side-channel, exactly like `trace`. A lost ask is bad; a lost turn — the one
    // the operator is waiting on — is worse.
    const { cleanup } = harness();
    try {
      const sup = new Supervisor({
        defaultWorkspace: ws,
        onAsk: () => {
          throw new Error("disk on fire");
        },
        run: runnerEmitting([awaiting, askEvent("toolu_01", [{ question: "Q?" }])]),
      } as never);
      const r = await sup.dispatch("t1", "do it");
      expect(r.phase).toBe("done");
    } finally {
      cleanup();
    }
  });
});
