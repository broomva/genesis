import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentEvent,
  type PartialStreamEvent,
  parseLine,
  parseStream,
  sessionIdOf,
  streamBlockStart,
  streamTextDelta,
  streamThinkingDelta,
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
    expect(
      parseLine('{"type":"stream_event","event":{"type":"message_start"},"session_id":"s"}')?.type,
    ).toBe("stream_event"); // BRO-1571 partial-message channel
  });

  test("stream_event delta accessors extract text / thinking / block-start", () => {
    const td = parseLine(
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}}',
    );
    const tk = parseLine(
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}}',
    );
    const bs = parseLine(
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}',
    );
    if (td?.type !== "stream_event" || tk?.type !== "stream_event" || bs?.type !== "stream_event")
      throw new Error("expected stream_event");
    expect(streamTextDelta(td.event)).toBe("Hel");
    expect(streamThinkingDelta(td.event)).toBeUndefined();
    expect(streamThinkingDelta(tk.event)).toBe("hmm");
    expect(streamBlockStart(bs.event)).toBe("text");
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

describe("projection reducer — hardened edges (post-P20)", () => {
  test("terminal states are absorbing: a trailing system after result stays done", () => {
    const done = reduceAll(fixture("success.ndjson"));
    expect(done.phase).toBe("done");
    const after = reduce(done, { type: "system", session_id: "sess-abc" });
    expect(after.phase).toBe("done"); // not re-opened to running
  });

  test("first terminal result wins: a later success cannot erase an earlier error", () => {
    let s = reduce(initialState, { type: "system", session_id: "s" });
    s = reduce(s, { type: "result", subtype: "error_max_turns", is_error: true });
    expect(s.phase).toBe("blocked");
    s = reduce(s, { type: "result", subtype: "success", result: "ok" });
    expect(s.phase).toBe("blocked"); // absorbed
  });

  test("awaiting survives a turn-ending result (HITL signal preserved)", () => {
    let s = reduceAll(fixture("awaiting.ndjson"));
    expect(s.phase).toBe("awaiting");
    s = reduce(s, { type: "result", subtype: "success", result: "turn ended" });
    expect(s.phase).toBe("awaiting");
    expect(s.pendingQuestion).toBe("Deploy to Railway or AWS?");
  });

  test("done clears any dangling pendingQuestion", () => {
    let s = reduce(initialState, {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
    });
    s = reduce(s, { type: "result", subtype: "success", result: "fin" });
    expect(s.phase).toBe("done");
    expect(s.pendingQuestion).toBeUndefined();
  });

  test("multiple questions are joined, not silently truncated", () => {
    const s = reduce(initialState, {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "AskUserQuestion",
            input: { questions: [{ question: "A?" }, { question: "B?" }] },
          },
        ],
      },
    });
    expect(s.pendingQuestion).toBe("A? | B?");
  });
});

describe("projection reducer — token streaming (BRO-1571)", () => {
  const sd = (event: PartialStreamEvent): AgentEvent => ({
    type: "stream_event",
    event,
    session_id: "s",
  });

  test("text_delta events accumulate lastText incrementally", () => {
    let s = reduce(initialState, { type: "system", session_id: "s" });
    s = reduce(s, sd({ type: "content_block_start", index: 0, content_block: { type: "text" } }));
    expect(s.lastText).toBe("");
    s = reduce(
      s,
      sd({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
    );
    expect(s.lastText).toBe("Hel"); // streams, not all-at-once
    s = reduce(
      s,
      sd({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
    );
    expect(s.lastText).toBe("Hello");
    expect(s.phase).toBe("running");
  });

  test("the final complete assistant event does not double the streamed text", () => {
    let s = reduce(initialState, { type: "system", session_id: "s" });
    s = reduce(s, sd({ type: "content_block_start", index: 0, content_block: { type: "text" } }));
    s = reduce(
      s,
      sd({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello world" },
      }),
    );
    // Complete assistant message arrives with the full text == accumulated.
    s = reduce(s, {
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    });
    expect(s.lastText).toBe("Hello world");
    expect(s.turns).toBe(1); // assistant stays the turn-count authority
    s = reduce(s, { type: "result", subtype: "success", result: "Hello world" });
    expect(s.phase).toBe("done");
    expect(s.lastText).toBe("Hello world"); // no duplication
  });

  test("thinking_delta accumulates into reasoning, separate from lastText", () => {
    let s = reduce(initialState, { type: "system", session_id: "s" });
    s = reduce(
      s,
      sd({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
    );
    s = reduce(
      s,
      sd({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "let me " },
      }),
    );
    s = reduce(
      s,
      sd({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "think" },
      }),
    );
    expect(s.reasoning).toBe("let me think");
    expect(s.lastText).toBeUndefined(); // reasoning never leaks into the answer
    // then the visible answer streams in its own block
    s = reduce(s, sd({ type: "content_block_start", index: 1, content_block: { type: "text" } }));
    s = reduce(
      s,
      sd({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } }),
    );
    expect(s.lastText).toBe("Done.");
    expect(s.reasoning).toBe("let me think"); // preserved
  });

  test("thinking_delta captures max estimated_tokens as the is-thinking signal (BRO-1574)", () => {
    let s = reduce(initialState, { type: "system", session_id: "s" });
    s = reduce(
      s,
      sd({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
    );
    s = reduce(
      s,
      sd({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "", estimated_tokens: 50 },
      }),
    );
    s = reduce(
      s,
      sd({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "", estimated_tokens: 150 },
      }),
    );
    expect(s.thinkingTokens).toBe(150); // max, the indicator basis
    expect(s.reasoning).toBe(""); // prose redacted under subscription auth
  });

  test("a new text block resets lastText so blocks render separately", () => {
    let s = reduce(initialState, { type: "system", session_id: "s" });
    s = reduce(s, sd({ type: "content_block_start", index: 0, content_block: { type: "text" } }));
    s = reduce(
      s,
      sd({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "first" } }),
    );
    expect(s.lastText).toBe("first");
    s = reduce(s, sd({ type: "content_block_start", index: 1, content_block: { type: "text" } }));
    expect(s.lastText).toBe(""); // reset boundary — connector opens a new text part
    s = reduce(
      s,
      sd({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "second" } }),
    );
    expect(s.lastText).toBe("second");
  });

  test("non-text stream events keep the run alive and capture session id", () => {
    let s = reduce(initialState, { type: "system", session_id: "s" });
    s = reduce(s, sd({ type: "message_start" }));
    s = reduce(s, sd({ type: "message_stop" }));
    expect(s.phase).toBe("running");
    expect(s.sessionId).toBe("s");
  });
});

describe("projection reducer — parts timeline (BRO-1607)", () => {
  test("tool round-trip builds an ordered text · tool · text timeline with matched output", () => {
    const s = reduceAll(fixture("tool.ndjson"));
    expect(s.parts).toEqual([
      { type: "text", text: "Let me check the files." },
      {
        type: "tool",
        toolCallId: "tu1",
        toolName: "Bash",
        input: { command: "ls" },
        output: "README.md",
        state: "output-available",
      },
      { type: "text", text: "Found README.md." },
    ]);
  });

  test("a simple turn yields a single text part", () => {
    const s = reduceAll(fixture("success.ndjson"));
    expect(s.parts).toEqual([{ type: "text", text: "Hello, I'll help with that." }]);
  });

  test("an errored tool_result marks the tool part output-error", () => {
    let s = reduce(initialState, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } }] },
    });
    s = reduce(s, {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }],
      },
    });
    expect(s.parts).toEqual([
      {
        type: "tool",
        toolCallId: "t1",
        toolName: "Bash",
        input: { command: "x" },
        output: "boom",
        state: "output-error",
      },
    ]);
  });

  test("AskUserQuestion is a HITL gate, not a timeline tool part", () => {
    const s = reduce(initialState, {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [] } },
        ],
      },
    });
    expect(s.phase).toBe("awaiting");
    expect(s.parts).toEqual([]); // excluded from the renderable timeline
  });

  test("a re-emitted identical assistant message does not double-append a tool (idempotent by id)", () => {
    const assistant: AgentEvent = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
    };
    let s = reduce(initialState, assistant);
    s = reduce(s, assistant); // mid-stream replay of the SAME message
    expect(s.parts?.filter((p) => p.type === "tool")).toHaveLength(1);
  });

  test("a tool_result with no matching tool_use is ignored (no orphan part)", () => {
    const s = reduce(initialState, {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "ghost", content: "x" }] },
    });
    expect(s.parts).toEqual([]);
  });

  test("parts survive folding through to the terminal result", () => {
    const s = reduceAll(fixture("tool.ndjson"));
    expect(s.phase).toBe("done");
    expect(s.parts?.filter((p) => p.type === "tool")).toHaveLength(1);
  });
});

describe("projection reducer — reasoning detection (BRO-1608)", () => {
  const sd = (event: PartialStreamEvent): AgentEvent => ({
    type: "stream_event",
    event,
    session_id: "s",
  });

  test("signature_delta alone marks reasoned (effort high: no thinking_delta, no tokens)", () => {
    const s = reduce(
      { phase: "running", turns: 0 },
      sd({ type: "content_block_delta", index: 0, delta: { type: "signature_delta" } }),
    );
    expect(s.reasoned).toBe(true);
    expect(s.thinkingTokens ?? 0).toBe(0); // no estimate at effort high — reasoned is the signal
  });

  test("content_block_start thinking marks reasoned", () => {
    const s = reduce(
      initialState,
      sd({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
    );
    expect(s.reasoned).toBe(true);
  });

  test("a complete (signature-only, redacted) thinking block marks reasoned", () => {
    const s = reduce(initialState, {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: "The answer." },
        ],
      },
    });
    expect(s.reasoned).toBe(true);
    expect(s.reasoning ?? "").toBe(""); // prose redacted, but we know it thought
  });

  test("verbatim thinking prose is captured when the deployment provides it", () => {
    const s = reduce(initialState, {
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "let me reason about X" }] },
    });
    expect(s.reasoning).toBe("let me reason about X");
    expect(s.reasoned).toBe(true);
  });

  test("a turn with no thinking leaves reasoned falsy", () => {
    expect(reduceAll(fixture("success.ndjson")).reasoned).toBeFalsy();
    expect(reduceAll(fixture("tool.ndjson")).reasoned).toBeFalsy();
  });
});

describe("projection reducer — usage + cost (BRO-1597)", () => {
  test("result usage + total_cost_usd fold into RunState", () => {
    const s = reduce(
      { phase: "running", turns: 1 },
      {
        type: "result",
        subtype: "success",
        result: "done",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
        },
        total_cost_usd: 0.0123,
      },
    );
    expect(s.phase).toBe("done");
    expect(s.usage).toEqual({ input: 100, output: 20, cacheRead: 5, cacheCreation: 3 });
    expect(s.costUsd).toBe(0.0123);
  });

  test("a result with no usage leaves usage/cost undefined", () => {
    const s = reduce(
      { phase: "running", turns: 1 },
      { type: "result", subtype: "success", result: "x" },
    );
    expect(s.usage).toBeUndefined();
    expect(s.costUsd).toBeUndefined();
  });

  test("usage is captured even when the turn stays awaiting (HITL)", () => {
    const s = reduce(
      { phase: "awaiting", turns: 1 },
      { type: "result", subtype: "success", usage: { input_tokens: 7 }, total_cost_usd: 0.001 },
    );
    expect(s.phase).toBe("awaiting"); // F4 preserved
    expect(s.usage).toEqual({ input: 7, output: 0, cacheRead: 0, cacheCreation: 0 });
    expect(s.costUsd).toBe(0.001);
  });

  test("an errored result still captures usage + cost (failed turns bill tokens)", () => {
    const s = reduce(
      { phase: "running", turns: 1 },
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        usage: { input_tokens: 50, output_tokens: 5 },
        total_cost_usd: 0.002,
      },
    );
    expect(s.phase).toBe("blocked"); // still terminal-error
    expect(s.error).toBe("error_max_turns");
    expect(s.usage).toEqual({ input: 50, output: 5, cacheRead: 0, cacheCreation: 0 });
    expect(s.costUsd).toBe(0.002);
  });
});
