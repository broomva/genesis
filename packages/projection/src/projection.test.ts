import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentEvent,
  parseLine,
  parseStream,
  sessionIdOf,
  textBlocks,
  toolUses,
} from "./parser";
import { type RunState, initialState, reduce, reduceAll } from "./reducer";

function fixture(name: string): AgentEvent[] {
  const raw = readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8");
  return parseStream(raw);
}

describe("parser", () => {
  test("parses each event type", () => {
    expect(parseLine('{"type":"system","session_id":"s"}')?.type).toBe("system");
    expect(parseLine('{"type":"assistant","message":{"content":[]}}')?.type).toBe("assistant");
    expect(parseLine('{"type":"user","message":{"content":[]}}')?.type).toBe("user");
    expect(parseLine('{"type":"result","subtype":"success"}')?.type).toBe("result");
  });

  test("rejects blanks, malformed JSON, and unknown types", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
    expect(parseLine("not json {{{")).toBeNull();
    expect(parseLine('{"type":"telemetry"}')).toBeNull();
    expect(parseLine('"a-bare-string"')).toBeNull();
  });

  test("extracts session_id from any carrier", () => {
    expect(sessionIdOf(parseLine('{"type":"system","session_id":"s1"}') as AgentEvent)).toBe("s1");
    expect(sessionIdOf(parseLine('{"type":"result","session_id":"s2"}') as AgentEvent)).toBe("s2");
  });

  test("extracts text and tool_use blocks", () => {
    const msg = {
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
      ],
    };
    expect(textBlocks(msg)).toEqual(["hi"]);
    expect(toolUses(msg)).toEqual([{ name: "Bash", input: { command: "ls" } }]);
  });

  test("parseStream drops noise and keeps order", () => {
    const evs = fixture("noise.ndjson");
    expect(evs.map((e) => e.type)).toEqual(["system", "result"]);
  });
});

describe("projection reducer — RunPhase state machine", () => {
  test("system init → running, captures session id", () => {
    const s = reduce(initialState, { type: "system", session_id: "s" });
    expect(s.phase).toBe("running");
    expect(s.sessionId).toBe("s");
  });

  test("success stream → done, surfaces final result text", () => {
    const s = reduceAll(fixture("success.ndjson"));
    expect(s.phase).toBe("done");
    expect(s.sessionId).toBe("sess-abc");
    expect(s.lastText).toBe("Done: said hello.");
    expect(s.turns).toBe(1);
  });

  test("tool round-trip stays running mid-stream, done at result", () => {
    const evs = fixture("tool.ndjson");
    // mid-stream after the tool_use assistant turn → still running
    const mid = reduceAll(evs.slice(0, 2));
    expect(mid.phase).toBe("running");
    const end = reduceAll(evs);
    expect(end.phase).toBe("done");
    expect(end.turns).toBe(2);
  });

  test("AskUserQuestion tool_use → awaiting, captures the question", () => {
    const s = reduceAll(fixture("awaiting.ndjson"));
    expect(s.phase).toBe("awaiting");
    expect(s.pendingQuestion).toBe("Deploy to Railway or AWS?");
  });

  test("a tool_result after awaiting clears the gate back to running", () => {
    const awaiting: RunState = reduceAll(fixture("awaiting.ndjson"));
    expect(awaiting.phase).toBe("awaiting");
    const resumed = reduce(awaiting, {
      type: "user",
      message: { content: [{ type: "tool_result", content: "Railway" }] },
    });
    expect(resumed.phase).toBe("running");
    expect(resumed.pendingQuestion).toBeUndefined();
  });

  test("error result → blocked, carries the failure subtype", () => {
    const s = reduceAll(fixture("error.ndjson"));
    expect(s.phase).toBe("blocked");
    expect(s.error).toBe("error_max_turns");
  });

  test("reduce is pure — replaying the same events yields the same state", () => {
    const evs = fixture("tool.ndjson");
    expect(reduceAll(evs)).toEqual(reduceAll(evs));
  });
});
