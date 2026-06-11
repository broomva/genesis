import { describe, expect, test } from "bun:test";
import { type PostableThread, handleAgentMessage } from "./handler";

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
}
const part = (p: object) => `data: ${JSON.stringify(p)}\n\n`;

/** Mock thread that drains streamed posts into captured strings. */
function mockThread(id = "tg-1"): PostableThread & { posts: string[]; typingCount: number } {
  const posts: string[] = [];
  let typingCount = 0;
  return {
    id,
    posts,
    get typingCount() {
      return typingCount;
    },
    async startTyping() {
      typingCount++;
    },
    async post(content: string | AsyncIterable<string>) {
      if (typeof content === "string") {
        posts.push(content);
      } else {
        let s = "";
        for await (const c of content) s += c;
        posts.push(s);
      }
    },
  } as PostableThread & { posts: string[]; typingCount: number };
}

function okFetch(reply: string): typeof fetch {
  return (async () =>
    new Response(
      sseBody([
        part({ type: "text-start", id: "t" }),
        part({ type: "text-delta", id: "t", delta: reply }),
        part({ type: "text-end", id: "t" }),
        part({ type: "finish" }),
      ]),
      { status: 200 },
    )) as unknown as typeof fetch;
}

describe("handleAgentMessage", () => {
  test("streams the agent reply into the thread and signals typing", async () => {
    const thread = mockThread();
    await handleAgentMessage(thread, "what is 2+2?", {
      baseUrl: "https://x",
      fetchImpl: okFetch("4"),
    });
    expect(thread.posts).toEqual(["4"]);
    expect(thread.typingCount).toBe(1);
  });

  test("ignores empty/whitespace messages (no post, no call)", async () => {
    const thread = mockThread();
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await handleAgentMessage(thread, "   ", { baseUrl: "https://x", fetchImpl });
    expect(thread.posts).toEqual([]);
    expect(called).toBe(false);
  });

  test("surfaces a Genesis failure as a posted message, never throws", async () => {
    const thread = mockThread();
    const fetchImpl = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    await handleAgentMessage(thread, "go", { baseUrl: "https://x", fetchImpl });
    expect(thread.posts.length).toBe(1);
    expect(thread.posts[0]).toContain("⚠️");
    expect(thread.posts[0]).toContain("HTTP 500");
  });

  test("uses the thread id as the continuity key", async () => {
    const thread = mockThread("tg-conversation-9");
    let sentId: string | undefined;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sentId = JSON.parse(init.body as string).id;
      return new Response(
        sseBody([
          part({ type: "text-start", id: "t" }),
          part({ type: "text-delta", id: "t", delta: "hi" }),
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await handleAgentMessage(thread, "hello", { baseUrl: "https://x", fetchImpl });
    expect(sentId).toBe("tg-conversation-9");
  });
});
