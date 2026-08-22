import { describe, expect, test } from "bun:test";
import {
  type PostableThread,
  chunkForWhatsapp,
  drainStream,
  handleAgentMessage,
  workspaceDecisionFor,
  workspaceIdFor,
  workspaceIsRegistered,
} from "./handler";

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

describe("workspaceDecisionFor — per-sender WhatsApp confinement (BRO-2224)", () => {
  const PREFIX = "ws-wa-";
  // Real Kapso thread ids: kapso:<b64url(phoneNumberId)>:<b64url(waId)>
  const b64 = (v: string) => Buffer.from(v, "utf8").toString("base64url");
  const thread = (pnid: string, waId: string, convId?: string) =>
    `kapso:${b64(pnid)}:${b64(waId)}${convId ? `:${b64(convId)}` : ""}`;

  const ALICE = thread("1314014011788509", "573001234567");
  const BOB = thread("1314014011788509", "573009999999");

  test("a sender is pinned to ITS OWN workspace, derived from the waId", () => {
    expect(workspaceDecisionFor(ALICE, PREFIX)).toEqual({
      kind: "pin",
      workspaceId: "ws-wa-573001234567",
    });
  });

  test("TWO SENDERS GET TWO WORKSPACES — the whole point of BRO-2224", () => {
    const a = workspaceDecisionFor(ALICE, PREFIX);
    const b = workspaceDecisionFor(BOB, PREFIX);
    expect(a.kind).toBe("pin");
    expect(b.kind).toBe("pin");
    expect(a).not.toEqual(b);
  });

  test("the same sender KEEPS its workspace across conversations", () => {
    // Persistence per phone number: a new Kapso conversation id appends a 4th
    // part. If that leaked into the key, every new conversation would strand
    // the tenant's files in a fresh directory.
    const withConv = thread("1314014011788509", "573001234567", "conv-abc");
    expect(workspaceDecisionFor(withConv, PREFIX)).toEqual(workspaceDecisionFor(ALICE, PREFIX));
  });

  test("OUR number is not the tenant key — same sender via a different number", () => {
    // phoneNumberId is part 1 and is identical on every inbound message. Keying
    // on it would give every sender in the world one shared workspace.
    const viaOtherNumber = thread("597907523413541", "573001234567");
    expect(workspaceDecisionFor(viaOtherNumber, PREFIX)).toEqual(
      workspaceDecisionFor(ALICE, PREFIX),
    );
  });

  test("a phone number is normalized to digits, so one sender is one directory", () => {
    expect(workspaceDecisionFor(thread("111", "+57 300 123-4567"), PREFIX)).toEqual({
      kind: "pin",
      workspaceId: "ws-wa-573001234567",
    });
  });

  test("confinement NEVER leaks to another channel", () => {
    for (const id of ["telegram:547052379", "547052379", "slack:C123"]) {
      expect(workspaceDecisionFor(id, PREFIX)).toEqual({ kind: "inherit" });
    }
  });

  test("a lookalike prefix is not WhatsApp", () => {
    expect(workspaceDecisionFor("kapsoX:abc:def", PREFIX)).toEqual({ kind: "inherit" });
    expect(workspaceDecisionFor("notkapso:abc:def", PREFIX)).toEqual({ kind: "inherit" });
  });

  // --- the fail direction, which is where the old signature was wrong -------

  test("an UNRESOLVABLE WhatsApp thread REFUSES — it does not inherit", () => {
    // Regression guard for the shape this replaced. Returning undefined here
    // would mean "inherit the engine default" = /home/agent, so a thread we
    // cannot attribute would get the BROADEST workspace on the box. The only
    // safe answer for a channel we confine is: do not run.
    for (const bad of [
      "kapso:MTIzNDU2:!!!notbase64!!!", // undecodable waId
      "kapso:MTIzNDU2:", // empty waId
      "kapso:MTIzNDU2", // too few parts
      "kapso:a:b:c:d:e", // too many parts
    ]) {
      const d = workspaceDecisionFor(bad, PREFIX);
      expect(d.kind).toBe("refuse");
    }
  });

  test("a waId with no digits REFUSES rather than making an empty-suffix id", () => {
    // Otherwise the id collapses to the bare prefix — one shared workspace that
    // every unparseable sender lands in together.
    const d = workspaceDecisionFor(thread("111", "no-digits-here"), PREFIX);
    expect(d.kind).toBe("refuse");
  });

  test("unset/blank prefix REFUSES for WhatsApp, inherits for everyone else", () => {
    for (const cfg of [undefined, "", "   "]) {
      expect(workspaceDecisionFor(ALICE, cfg).kind).toBe("refuse");
      expect(workspaceDecisionFor("telegram:1", cfg)).toEqual({ kind: "inherit" });
    }
  });

  test("workspaceIdFor shim collapses refuse to undefined (why it is off-path)", () => {
    // Documents the hazard rather than hiding it: this shim cannot distinguish
    // "inherit the default" from "must not run", so the dispatch path uses
    // workspaceDecisionFor instead.
    expect(workspaceIdFor(ALICE, PREFIX)).toBe("ws-wa-573001234567");
    expect(workspaceIdFor("kapso:MTIzNDU2:", PREFIX)).toBeUndefined();
    expect(workspaceIdFor("telegram:1", PREFIX)).toBeUndefined();
  });
});

describe("workspaceIsRegistered — confinement precheck (BRO-2216)", () => {
  // Shape of a real GET /workspaces response from the VPS.
  const payload = {
    workspaces: [
      { id: "ws-default", name: "root", available: true, worktreeCapable: false },
      { id: "ws-broomva", name: "broomva", available: true, worktreeCapable: false },
      { id: "ws-orchestrator", name: "orchestrator", available: true, worktreeCapable: false },
    ],
    defaultWorkspace: "ws-default",
  };

  test("a registered, available workspace passes", () => {
    expect(workspaceIsRegistered(payload, "ws-orchestrator")).toBe(true);
  });

  test("an unregistered id fails — the whole point", () => {
    // The engine would bind this to ws-default (/home/agent) and say nothing.
    expect(workspaceIsRegistered(payload, "ws-doesnotexist")).toBe(false);
    expect(workspaceIsRegistered(payload, "ws-orchestrato")).toBe(false); // typo
    expect(workspaceIsRegistered(payload, "orchestrator")).toBe(false); // name, not id
  });

  test("registered but UNAVAILABLE fails", () => {
    const p = { workspaces: [{ id: "ws-gone", available: false }] };
    expect(workspaceIsRegistered(p, "ws-gone")).toBe(false);
  });

  test("available omitted is treated as usable", () => {
    // Only an explicit `false` means unavailable; absent is the common shape.
    expect(workspaceIsRegistered({ workspaces: [{ id: "ws-x" }] }, "ws-x")).toBe(true);
  });

  test("unrecognizable payloads fail — unverifiable is not fine", () => {
    for (const bad of [
      null,
      undefined,
      {},
      [],
      "nope",
      42,
      { workspaces: "no" },
      { workspaces: [null] },
    ]) {
      expect(workspaceIsRegistered(bad, "ws-orchestrator")).toBe(false);
    }
  });

  test("a blank wanted id never passes", () => {
    for (const w of ["", "   "]) expect(workspaceIsRegistered(payload, w)).toBe(false);
  });
});

describe("chunkForWhatsapp — buffered delivery (BRO-2216)", () => {
  test("short text stays one chunk", () => {
    expect(chunkForWhatsapp("hello")).toEqual(["hello"]);
  });

  test("empty/whitespace yields NO chunks (never post an empty message)", () => {
    for (const t of ["", "   ", "\n\n"]) expect(chunkForWhatsapp(t)).toEqual([]);
  });

  test("long text splits and every chunk is within the limit", () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} of some text`).join("\n");
    const chunks = chunkForWhatsapp(long, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
  });

  test("no content is lost across chunks", () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const joined = chunkForWhatsapp(long, 300).join(" ");
    expect(joined.replace(/\s+/g, " ")).toBe(long.replace(/\s+/g, " "));
  });

  test("a single unbreakable run still splits rather than exceeding the limit", () => {
    const blob = "x".repeat(1200);
    const chunks = chunkForWhatsapp(blob, 400);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(400);
    expect(chunks.join("")).toBe(blob);
  });

  test("prefers paragraph boundaries when available", () => {
    const text = `${"a".repeat(200)}\n\n${"b".repeat(200)}`;
    const chunks = chunkForWhatsapp(text, 250);
    expect(chunks[0]).toBe("a".repeat(200));
  });
});

describe("drainStream", () => {
  async function* gen(parts: string[]) {
    for (const p of parts) yield p;
  }
  test("concatenates every piece in order", async () => {
    expect(await drainStream(gen(["a", "b", "c"]))).toBe("abc");
  });
  test("empty stream yields empty string", async () => {
    expect(await drainStream(gen([]))).toBe("");
  });
});
