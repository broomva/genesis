import { describe, expect, test } from "bun:test";
import { buildRequestBody, genesisStream, parseSse } from "./genesis";

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

/** Mock fetch returning a canned SSE stream (or an error status). */
function mockFetch(chunks: string[], opts: { ok?: boolean; status?: number } = {}): typeof fetch {
  const status = opts.status ?? 200;
  return (async () =>
    new Response(opts.ok === false ? null : sseBody(chunks), {
      status,
    })) as unknown as typeof fetch;
}

function part(p: object): string {
  return `data: ${JSON.stringify(p)}\n\n`;
}

async function collect(it: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const s of it) out += s;
  return out;
}

describe("buildRequestBody", () => {
  test("produces the AI SDK chat request shape Genesis expects", () => {
    expect(buildRequestBody("thread-1", "hi")).toEqual({
      id: "thread-1",
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    });
  });
});

describe("parseSse", () => {
  test("parses framed parts and skips [DONE] + non-JSON keepalives", async () => {
    const body = sseBody([
      part({ type: "start", messageId: "m" }),
      ":\n\n", // keepalive comment frame
      part({ type: "text-delta", id: "t", delta: "hi" }),
      "data: [DONE]\n\n",
    ]);
    const types: string[] = [];
    for await (const p of parseSse(body)) types.push(p.type);
    expect(types).toEqual(["start", "text-delta"]);
  });

  test("flushes a final frame NOT terminated by a blank line (truncated tail)", async () => {
    // last frame has no trailing "\n\n" — must still be emitted, not dropped
    const body = sseBody([
      part({ type: "text-delta", id: "t", delta: "first" }),
      'data: {"type":"text-delta","id":"t","delta":"last"}', // no trailing \n\n
    ]);
    const deltas = [];
    for await (const p of parseSse(body)) if (p.type === "text-delta") deltas.push(p.delta);
    expect(deltas).toEqual(["first", "last"]);
  });

  test("reassembles a part split across chunk boundaries", async () => {
    const frame = part({ type: "text-delta", id: "t", delta: "hello world" });
    const mid = Math.floor(frame.length / 2);
    const body = sseBody([frame.slice(0, mid), frame.slice(mid)]); // split mid-frame
    const parts = [];
    for await (const p of parseSse(body)) parts.push(p);
    expect(parts).toEqual([{ type: "text-delta", id: "t", delta: "hello world" }]);
  });
});

describe("genesisStream", () => {
  test("yields the assistant text for a single-block reply", async () => {
    const fetchImpl = mockFetch([
      part({ type: "start", messageId: "m" }),
      part({ type: "text-start", id: "t1" }),
      part({ type: "text-delta", id: "t1", delta: "The answer " }),
      part({ type: "text-delta", id: "t1", delta: "is 42." }),
      part({ type: "text-end", id: "t1" }),
      part({ type: "finish" }),
      "data: [DONE]\n\n",
    ]);
    const out = await collect(
      genesisStream({ baseUrl: "https://x", threadId: "c1", text: "q", fetchImpl }),
    );
    expect(out).toBe("The answer is 42.");
  });

  test("separates distinct narration blocks with a blank line (no concatenation)", async () => {
    const fetchImpl = mockFetch([
      part({ type: "text-start", id: "t1" }),
      part({ type: "text-delta", id: "t1", delta: "Checking the files." }),
      part({ type: "text-end", id: "t1" }),
      part({ type: "text-start", id: "t2" }),
      part({ type: "text-delta", id: "t2", delta: "The bug is on line 42." }),
      part({ type: "text-end", id: "t2" }),
      part({ type: "finish" }),
    ]);
    const out = await collect(
      genesisStream({ baseUrl: "https://x", threadId: "c1", text: "q", fetchImpl }),
    );
    expect(out).toBe("Checking the files.\n\nThe bug is on line 42.");
  });

  test("sends the thread id as the Genesis session id (continuity)", async () => {
    let sentBody: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      return new Response(
        sseBody([
          part({ type: "text-start", id: "t" }),
          part({ type: "text-delta", id: "t", delta: "ok" }),
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await collect(
      genesisStream({ baseUrl: "https://x", threadId: "tg-555", text: "hey", fetchImpl }),
    );
    expect((sentBody as { id: string }).id).toBe("tg-555");
  });

  test("throws on a Genesis error part", async () => {
    const fetchImpl = mockFetch([
      part({ type: "text-start", id: "t" }),
      part({ type: "text-delta", id: "t", delta: "working" }),
      part({ type: "error", errorText: "agent exited 1" }),
    ]);
    await expect(
      collect(genesisStream({ baseUrl: "https://x", threadId: "c", text: "q", fetchImpl })),
    ).rejects.toThrow("agent exited 1");
  });

  test("throws on a non-2xx response", async () => {
    const fetchImpl = mockFetch([], { ok: false, status: 503 });
    await expect(
      collect(genesisStream({ baseUrl: "https://x", threadId: "c", text: "q", fetchImpl })),
    ).rejects.toThrow("HTTP 503");
  });
});
