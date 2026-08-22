import { describe, expect, test } from "bun:test";
import { type PostableThread, handleAgentMessage, workspaceIdFor } from "./handler";

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
    expect(thread.posts[0]).toContain("⚠️"); // generic user-facing message; detail is logged, not posted
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

describe("workspaceIdFor — WhatsApp confinement (BRO-2216)", () => {
  const WS = "ws-orchestrator";
  // A real Kapso thread id: kapso:<b64url(phoneNumberId)>:<b64url(waId)>
  const KAPSO = "kapso:MTIzNDU2:NTczMDAxMjM0NTY3";

  test("a WhatsApp thread is pinned to the dedicated workspace", () => {
    expect(workspaceIdFor(KAPSO, WS)).toBe(WS);
  });

  test("the WhatsApp workspace NEVER leaks to another channel", () => {
    // The direction that actually matters: pinning is confinement for WhatsApp,
    // not a global default for everyone.
    expect(workspaceIdFor("telegram:547052379", WS)).toBeUndefined();
    expect(workspaceIdFor("547052379", WS)).toBeUndefined();
    expect(workspaceIdFor("slack:C123", WS)).toBeUndefined();
  });

  test("unset/blank config → inherit the engine default, never a guess", () => {
    for (const cfg of [undefined, "", "   "]) {
      expect(workspaceIdFor(KAPSO, cfg)).toBeUndefined();
    }
  });

  test("surrounding whitespace in the configured id is tolerated", () => {
    expect(workspaceIdFor(KAPSO, `  ${WS}  `)).toBe(WS);
  });

  test("a lookalike prefix does not count as WhatsApp", () => {
    expect(workspaceIdFor("kapsoX:abc:def", WS)).toBeUndefined();
    expect(workspaceIdFor("notkapso:abc:def", WS)).toBeUndefined();
  });
});
