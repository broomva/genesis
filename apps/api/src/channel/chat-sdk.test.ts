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

async function collect(events: OutgoingEvent[]): Promise<UiStreamPart[]> {
  async function* gen() {
    for (const e of events) yield e;
  }
  const out: UiStreamPart[] = [];
  for await (const p of toUiStreamParts(gen(), { messageId: "m1", textId: "t1" })) out.push(p);
  return out;
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

  test("emits only the NEW suffix when text grows across events (no duplication)", async () => {
    const parts = await collect([
      { kind: "phase", phase: "running", text: "Thinking" },
      { kind: "phase", phase: "running", text: "Thinking about it" },
      { kind: "reply", phase: "done", text: "Thinking about it — done." },
    ]);
    const deltas = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta);
    expect(deltas.join("")).toBe("Thinking about it — done.");
    expect(deltas).toEqual(["Thinking", " about it", " — done."]);
  });

  test("a replacement (non-prefix) text is emitted whole", async () => {
    const parts = await collect([
      { kind: "phase", phase: "running", text: "draft" },
      { kind: "reply", phase: "done", text: "final answer" },
    ]);
    const deltas = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta);
    expect(deltas).toEqual(["draft", "final answer"]);
  });

  test("an error event yields an error part before finish", async () => {
    const parts = await collect([
      { kind: "phase", phase: "running", text: "working" },
      { kind: "error", message: "agent exited 1" },
    ]);
    expect(
      parts.some(
        (p) => p.type === "error" && (p as { errorText: string }).errorText === "agent exited 1",
      ),
    ).toBe(true);
    expect(parts[parts.length - 1]).toEqual({ type: "finish" });
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

describe("uiMessageStreamResponse — full SSE wire output", () => {
  test("produces the exact SSE byte stream ending in [DONE]", async () => {
    async function* gen() {
      yield { kind: "reply", phase: "done", text: "hi" } as OutgoingEvent;
    }
    const res = uiMessageStreamResponse(gen(), { messageId: "m", textId: "t" });
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

  test("a thrown error mid-stream still terminates with finish + [DONE]", async () => {
    async function* gen(): AsyncGenerator<OutgoingEvent> {
      yield { kind: "phase", phase: "running", text: "go" };
      throw new Error("boom");
    }
    const body = await uiMessageStreamResponse(gen(), { messageId: "m", textId: "t" }).text();
    expect(body).toContain('"type":"error","errorText":"boom"');
    expect(body.endsWith(SSE_DONE)).toBe(true);
  });
});
