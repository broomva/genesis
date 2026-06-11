// Contract tests for ClaudeCodeAdapter against a REAL captured transcript
// (fixtures/v2.1.173-probe-session.jsonl — the 2026-06-11 hook probe).
// This corpus is the per-version drift instrument: when a new Claude Code
// release changes the transcript, capture a new fixture and diff the IR.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "../src/adapter";
import type { IREvent } from "../src/ir";

const FIXTURE = join(import.meta.dir, "fixtures", "v2.1.173-probe-session.jsonl");

async function fixtureEvents(): Promise<{ events: IREvent[]; adapter: ClaudeCodeAdapter }> {
  const adapter = new ClaudeCodeAdapter({ sessionId: "fixture" });
  const text = await Bun.file(FIXTURE).text();
  const events: IREvent[] = [];
  for (const line of text.split("\n")) {
    events.push(...adapter.lineToEvents(line));
  }
  return { events, adapter };
}

describe("ClaudeCodeAdapter on the v2.1.173 fixture", () => {
  test("extracts the full semantic tool flow", async () => {
    const { events } = await fixtureEvents();
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("message.user");
    expect(kinds).toContain("thinking");
    expect(kinds).toContain("tool.use");
    expect(kinds).toContain("tool.result");
    expect(kinds).toContain("message.assistant");

    const toolUse = events.find((e) => e.kind === "tool.use");
    expect(toolUse?.kind === "tool.use" && toolUse.name).toBe("Bash");
    const toolResult = events.find((e) => e.kind === "tool.result");
    expect(toolResult?.kind === "tool.result" && String(toolResult.content)).toContain(
      "genesis-probe-ok",
    );
  });

  test("multiple block-lines of one message are NOT deduped (message.id trap)", async () => {
    const { events } = await fixtureEvents();
    // msg_01D1… is written as two transcript lines (thinking + tool_use).
    const sameMessage = events.filter(
      (e) =>
        (e.kind === "thinking" || e.kind === "tool.use") &&
        e.messageId === "msg_01D1KwRe3MSaYuGAjoTfPkA5",
    );
    expect(sameMessage.length).toBe(2);
  });

  test("replaying the same lines IS deduped by envelope uuid", async () => {
    const adapter = new ClaudeCodeAdapter({ sessionId: "fixture" });
    const text = await Bun.file(FIXTURE).text();
    const first: IREvent[] = [];
    const second: IREvent[] = [];
    for (const line of text.split("\n")) first.push(...adapter.lineToEvents(line));
    for (const line of text.split("\n")) second.push(...adapter.lineToEvents(line));
    const semantic = (events: IREvent[]) => events.filter((e) => e.kind !== "unknown");
    expect(semantic(first).length).toBeGreaterThan(0);
    expect(semantic(second).length).toBe(0);
  });

  test("known interactive-mode noise types are silent, not drift", async () => {
    const { events, adapter } = await fixtureEvents();
    // queue-operation / attachment / last-prompt / ai-title are in the fixture.
    const unknowns = events.filter((e) => e.kind === "unknown");
    expect(unknowns.length).toBe(0);
    expect(adapter.drift.total).toBe(0);
  });
});

describe("ClaudeCodeAdapter tolerance (the never-stall invariant)", () => {
  test("unknown entry types become passthrough events with drift telemetry", () => {
    const adapter = new ClaudeCodeAdapter({ sessionId: "s" });
    const events = adapter.lineToEvents(
      JSON.stringify({ type: "hologram-export", payload: { future: true } }),
    );
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("unknown");
    expect(events[0]?.kind === "unknown" && events[0].tag).toBe("hologram-export");
    expect(adapter.drift.total).toBe(1);
    expect(adapter.drift.bySurface.transcript["hologram-export"]).toBe(1);
  });

  test("malformed JSON, non-objects, and blank lines never throw", () => {
    const adapter = new ClaudeCodeAdapter({ sessionId: "s" });
    expect(adapter.lineToEvents("")).toEqual([]);
    expect(adapter.lineToEvents("   ")).toEqual([]);
    expect(adapter.lineToEvents("{broken json")).toHaveLength(1);
    expect(adapter.lineToEvents("42")).toHaveLength(1);
    expect(adapter.lineToEvents('"a string"')).toHaveLength(1);
    expect(adapter.lineToEvents("[1,2,3]")).toHaveLength(1);
  });

  test("unknown content-block types inside known messages are passthrough", () => {
    const adapter = new ClaudeCodeAdapter({ sessionId: "s" });
    const events = adapter.lineToEvents(
      JSON.stringify({
        type: "assistant",
        uuid: "u-1",
        message: {
          id: "m-1",
          role: "assistant",
          content: [
            { type: "text", text: "hi" },
            { type: "quantum_block", payload: 7 },
          ],
        },
      }),
    );
    expect(events.map((e) => e.kind)).toEqual(["message.assistant", "unknown"]);
  });

  test("future extra envelope fields are ignored, not fatal", () => {
    const adapter = new ClaudeCodeAdapter({ sessionId: "s" });
    const events = adapter.lineToEvents(
      JSON.stringify({
        type: "user",
        uuid: "u-2",
        newEnvelopeField: { anything: true },
        message: { role: "user", content: "hello" },
      }),
    );
    expect(events.map((e) => e.kind)).toEqual(["message.user"]);
    expect(events[0]?.kind === "message.user" && events[0].text).toBe("hello");
  });
});
