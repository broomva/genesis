import { describe, expect, test } from "bun:test";
import {
  SSE_DONE,
  UI_MESSAGE_STREAM_HEADERS,
  type UiStreamPart,
  encodePart,
  parseChatRequest,
  toUiStreamParts,
  uiMessageStreamResponse,
} from "./chat-sdk";
import type { OutgoingEvent } from "./types";

/** Deterministic ids: t1, t2, … (text) and r1, r2, … (reasoning) so multi-part
 *  assertions are stable. */
function deterministicIds() {
  let n = 0;
  let r = 0;
  return { messageId: "m1", newTextId: () => `t${++n}`, newReasoningId: () => `r${++r}` };
}

async function collectFrom(gen: AsyncIterable<OutgoingEvent>): Promise<UiStreamPart[]> {
  const out: UiStreamPart[] = [];
  for await (const p of toUiStreamParts(gen, deterministicIds())) out.push(p);
  return out;
}

async function collect(events: OutgoingEvent[]): Promise<UiStreamPart[]> {
  async function* gen() {
    for (const e of events) yield e;
  }
  return collectFrom(gen());
}

describe("parseChatRequest", () => {
  test("extracts threadId (id) + text from the UIMessage parts form", () => {
    const r = parseChatRequest({
      id: "chat-42",
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
          ],
        },
      ],
    });
    expect(r).toEqual({ threadId: "chat-42", text: "hello world" });
  });

  test("uses the LAST user message when several are present", () => {
    const r = parseChatRequest({
      id: "c",
      messages: [
        { role: "user", parts: [{ type: "text", text: "first" }] },
        { role: "assistant", parts: [{ type: "text", text: "reply" }] },
        { role: "user", parts: [{ type: "text", text: "second" }] },
      ],
    });
    expect(r.text).toBe("second");
  });

  test("accepts the plain {role, content:string} message shape", () => {
    expect(parseChatRequest({ id: "c", message: { role: "user", content: "hi there" } }).text).toBe(
      "hi there",
    );
  });

  test("defaults threadId to 'chat' when id is absent", () => {
    expect(
      parseChatRequest({ messages: [{ role: "user", parts: [{ type: "text", text: "x" }] }] })
        .threadId,
    ).toBe("chat");
  });

  test("throws on a non-object body or empty user text", () => {
    expect(() => parseChatRequest(null)).toThrow("must be an object");
    expect(() => parseChatRequest({ id: "c", messages: [] })).toThrow("no user text");
    expect(() => parseChatRequest({ id: "c", messages: [{ role: "user", parts: [] }] })).toThrow(
      "no user text",
    );
  });

  test("extracts per-turn model + valid effort from top-level body fields (BRO-1573)", () => {
    const r = parseChatRequest({
      id: "c",
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      model: "haiku",
      effort: "max",
    });
    expect(r.model).toBe("haiku");
    expect(r.effort).toBe("max");
  });

  test("drops an unknown effort value (never forwarded as --effort)", () => {
    const r = parseChatRequest({
      id: "c",
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      model: "  ", // whitespace-only → undefined
      effort: "off", // not in the enum → undefined
    });
    expect(r.model).toBeUndefined();
    expect(r.effort).toBeUndefined();
  });
});

describe("encodePart / SSE format", () => {
  test("encodes a part as a `data: {json}\\n\\n` SSE line", () => {
    expect(encodePart({ type: "text-delta", id: "t1", delta: "hi" })).toBe(
      'data: {"type":"text-delta","id":"t1","delta":"hi"}\n\n',
    );
  });
  test("the stream headers declare the UI message stream protocol v1", () => {
    expect(UI_MESSAGE_STREAM_HEADERS["x-vercel-ai-ui-message-stream"]).toBe("v1");
    expect(UI_MESSAGE_STREAM_HEADERS["content-type"]).toContain("text/event-stream");
  });
});

describe("toUiStreamParts — canonical events → UI message stream", () => {
  test("wraps a single reply in start/text-start/text-delta/text-end/finish", async () => {
    const parts = await collect([{ kind: "reply", phase: "done", text: "The answer is 42." }]);
    expect(parts).toEqual([
      { type: "start", messageId: "m1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "The answer is 42." },
      { type: "text-end", id: "t1" },
      { type: "finish" },
    ]);
  });

  test("PREFIX-extending text within one block streams as suffix deltas (one part)", async () => {
    const parts = await collect([
      { kind: "phase", phase: "running", text: "Thinking" },
      { kind: "phase", phase: "running", text: "Thinking about it" },
      { kind: "reply", phase: "done", text: "Thinking about it — done." },
    ]);
    // one text part, three suffix deltas — genuine incremental streaming
    expect(parts.filter((p) => p.type === "text-start").length).toBe(1);
    const deltas = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta);
    expect(deltas).toEqual(["Thinking", " about it", " — done."]);
  });

  test("emits a one-shot reasoning part BEFORE the first text (BRO-1574)", async () => {
    const parts = await collect([
      { kind: "phase", phase: "running", reasoning: "Extended thinking · ~150 tokens" },
      { kind: "phase", phase: "running", text: "The answer" },
      { kind: "reply", phase: "done", text: "The answer is 42." },
    ]);
    expect(parts.slice(0, 5).map((p) => p.type)).toEqual([
      "start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
    ]);
    expect((parts.find((p) => p.type === "reasoning-delta") as { delta: string }).delta).toBe(
      "Extended thinking · ~150 tokens",
    );
    // emitted exactly once even though reasoning rode multiple phase events
    expect(parts.filter((p) => p.type === "reasoning-start")).toHaveLength(1);
  });

  test("no reasoning part when the turn did no thinking", async () => {
    const parts = await collect([{ kind: "reply", phase: "done", text: "hi" }]);
    expect(parts.some((p) => p.type === "reasoning-start")).toBe(false);
  });

  test("NON-prefix blocks (real multi-turn lastText) render as SEPARATE parts, never concatenated (HIGH-1)", async () => {
    // the reducer's lastText is the latest text BLOCK — successive blocks are unrelated.
    const parts = await collect([
      { kind: "phase", phase: "running", text: "Let me check the files." },
      { kind: "phase", phase: "running", text: "Found it in config.ts." },
      { kind: "reply", phase: "done", text: "The bug is on line 42." },
    ]);
    // three distinct text parts, each closed before the next opens
    expect(parts).toEqual([
      { type: "start", messageId: "m1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Let me check the files." },
      { type: "text-end", id: "t1" },
      { type: "text-start", id: "t2" },
      { type: "text-delta", id: "t2", delta: "Found it in config.ts." },
      { type: "text-end", id: "t2" },
      { type: "text-start", id: "t3" },
      { type: "text-delta", id: "t3", delta: "The bug is on line 42." },
      { type: "text-end", id: "t3" },
      { type: "finish" },
    ]);
    // no delta is a concatenation of two blocks
    const deltas = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta);
    expect(deltas).toEqual([
      "Let me check the files.",
      "Found it in config.ts.",
      "The bug is on line 42.",
    ]);
  });

  test("an in-band error event closes the open text part BEFORE the error (text-end → error → finish)", async () => {
    const parts = await collect([
      { kind: "phase", phase: "running", text: "working" },
      { kind: "error", message: "agent exited 1" },
    ]);
    const tail = parts.slice(-3);
    expect(tail).toEqual([
      { type: "text-end", id: "t1" },
      { type: "error", errorText: "agent exited 1" },
      { type: "finish" },
    ]);
  });

  test("a THROWN producer rejection still closes the text part — no dangling open part (HIGH-2)", async () => {
    async function* gen(): AsyncGenerator<OutgoingEvent> {
      yield { kind: "phase", phase: "running", text: "partial" };
      throw new Error("dispatch blew up");
    }
    const parts = await collectFrom(gen());
    expect(parts.slice(-3)).toEqual([
      { type: "text-end", id: "t1" },
      { type: "error", errorText: "dispatch blew up" },
      { type: "finish" },
    ]);
    // exactly one text-start and one matching text-end — nothing left open
    expect(parts.filter((p) => p.type === "text-start").length).toBe(1);
    expect(parts.filter((p) => p.type === "text-end").length).toBe(1);
  });

  test("a rejection with NO text emitted yet → error + finish, no stray text-start/end", async () => {
    // an async iterable whose first next() rejects (before any event is yielded)
    const gen: AsyncIterable<OutgoingEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("immediate failure")),
      }),
    };
    const parts = await collectFrom(gen);
    expect(parts).toEqual([
      { type: "start", messageId: "m1" },
      { type: "error", errorText: "immediate failure" },
      { type: "finish" },
    ]);
  });

  test("skips empty/whitespace-free text events without emitting empty deltas", async () => {
    const parts = await collect([
      { kind: "phase", phase: "running" },
      { kind: "reply", phase: "done", text: "ok" },
    ]);
    expect(parts.filter((p) => p.type === "text-delta")).toEqual([
      { type: "text-delta", id: "t1", delta: "ok" },
    ]);
  });
});

describe("toUiStreamParts — dynamic tool parts (BRO-1607)", () => {
  const toolEvent = (
    state: "input-available" | "output-available" | "output-error",
    extra: Record<string, unknown> = {},
  ): OutgoingEvent => ({
    kind: "tool",
    part: {
      type: "tool",
      toolCallId: "tu1",
      toolName: "Bash",
      input: { command: "ls" },
      state,
      ...extra,
    },
  });

  test("text → tool → text renders the tool as its own part, between closed text parts", async () => {
    const parts = await collect([
      { kind: "phase", phase: "running", text: "Let me check the files." },
      toolEvent("input-available"),
      toolEvent("output-available", { output: "README.md" }),
      { kind: "reply", phase: "done", text: "Found README.md." },
    ]);
    expect(parts).toEqual([
      { type: "start", messageId: "m1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Let me check the files." },
      { type: "text-end", id: "t1" }, // closed BEFORE the tool
      {
        type: "tool-input-available",
        toolCallId: "tu1",
        toolName: "Bash",
        input: { command: "ls" },
        dynamic: true,
      },
      { type: "tool-output-available", toolCallId: "tu1", output: "README.md", dynamic: true },
      { type: "text-start", id: "t2" },
      { type: "text-delta", id: "t2", delta: "Found README.md." },
      { type: "text-end", id: "t2" },
      { type: "finish" },
    ]);
  });

  test("the STALE phase re-emit between tool-in and tool-out does NOT duplicate text (BRO-1607 regression)", async () => {
    // Faithful to server.ts: onState fires per reduced event and emits a `phase`
    // carrying state.lastText BEFORE draining tool parts. The tool_result `user`
    // event re-sends the unchanged lastText — which previously reopened a fresh
    // text part and re-streamed the whole sentence.
    const parts = await collect([
      { kind: "phase", phase: "running", text: "Let me check the files." },
      toolEvent("input-available"),
      { kind: "phase", phase: "running", text: "Let me check the files." }, // STALE re-emit
      toolEvent("output-available", { output: "README.md" }),
      { kind: "phase", phase: "running", text: "Found README.md." },
      { kind: "reply", phase: "done", text: "Found README.md." },
    ]);
    const deltas = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta);
    // exactly two text blocks — the pre-tool sentence is NOT repeated
    expect(deltas).toEqual(["Let me check the files.", "Found README.md."]);
    // structurally: one text part for each, the tool between them
    expect(parts.map((p) => p.type)).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-available",
      "tool-output-available",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
  });

  test("a failed tool emits tool-output-error with the error text", async () => {
    const parts = await collect([
      toolEvent("input-available"),
      toolEvent("output-error", { output: "command not found" }),
      { kind: "reply", phase: "done", text: "That failed." },
    ]);
    expect(parts).toContainEqual({
      type: "tool-output-error",
      toolCallId: "tu1",
      errorText: "command not found",
      dynamic: true,
    });
    // no tool-output-available for a failed tool
    expect(parts.some((p) => p.type === "tool-output-available")).toBe(false);
  });

  test("a tool before any text still flushes reasoning first", async () => {
    const parts = await collect([
      { kind: "phase", phase: "running", reasoning: "Extended thinking · ~50 tokens" },
      toolEvent("input-available"),
      { kind: "reply", phase: "done", text: "done" },
    ]);
    expect(parts.slice(0, 5).map((p) => p.type)).toEqual([
      "start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "tool-input-available",
    ]);
  });
});

describe("uiMessageStreamResponse — full SSE wire output", () => {
  test("produces the exact SSE byte stream ending in [DONE]", async () => {
    async function* gen() {
      yield { kind: "reply", phase: "done", text: "hi" } as OutgoingEvent;
    }
    const res = uiMessageStreamResponse(gen(), {
      messageId: "m",
      newTextId: () => "t",
      newReasoningId: () => "r",
    });
    expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    const body = await res.text();
    expect(body).toBe(
      [
        'data: {"type":"start","messageId":"m"}\n\n',
        'data: {"type":"text-start","id":"t"}\n\n',
        'data: {"type":"text-delta","id":"t","delta":"hi"}\n\n',
        'data: {"type":"text-end","id":"t"}\n\n',
        'data: {"type":"finish"}\n\n',
        SSE_DONE,
      ].join(""),
    );
  });

  test("a thrown error mid-stream closes the text part, then finish + [DONE]", async () => {
    async function* gen(): AsyncGenerator<OutgoingEvent> {
      yield { kind: "phase", phase: "running", text: "go" };
      throw new Error("boom");
    }
    const body = await uiMessageStreamResponse(gen(), {
      messageId: "m",
      newTextId: () => "t",
      newReasoningId: () => "r",
    }).text();
    // text-end precedes error (no dangling open part), and the stream still terminates.
    expect(body.indexOf('"type":"text-end"')).toBeLessThan(body.indexOf('"type":"error"'));
    expect(body).toContain('"type":"error","errorText":"boom"');
    expect(body.endsWith(SSE_DONE)).toBe(true);
  });
});

describe("toUiStreamParts — usage metadata (BRO-1597)", () => {
  const usage = { input: 100, output: 20, cacheRead: 5, cacheCreation: 3 };

  test("emits message-metadata before finish when the reply carries usage", async () => {
    const parts = await collect([
      { kind: "reply", phase: "done", text: "hi", usage, costUsd: 0.012 },
    ]);
    const metaIdx = parts.findIndex((p) => p.type === "message-metadata");
    const finishIdx = parts.findIndex((p) => p.type === "finish");
    expect(metaIdx).toBeGreaterThan(-1);
    expect(parts[metaIdx]).toEqual({
      type: "message-metadata",
      messageMetadata: { usage, costUsd: 0.012 },
    });
    expect(metaIdx).toBeLessThan(finishIdx); // metadata precedes finish
  });

  test("no message-metadata part when the reply reports no usage", async () => {
    const parts = await collect([{ kind: "reply", phase: "done", text: "hi" }]);
    expect(parts.some((p) => p.type === "message-metadata")).toBe(false);
  });
});
