import { describe, expect, test } from "bun:test";
import {
  CHUNK_TARGET,
  type PostableThread,
  STATUS_TIMEOUT_MS,
  TURN_STATUS_EMOJI,
  type TurnStatus,
  WHATSAPP_TEXT_LIMIT,
  chunkForWhatsapp,
  drainStream,
  handleAgentMessage,
  isOutsideServiceWindow,
  keepTyping,
  tenantWorkspaceId,
  unregisteredTenants,
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

describe("unregisteredTenants — every tenant, not just one (BRO-2224)", () => {
  const payload = {
    workspaces: [
      { id: "ws-wa-573001234567", available: true },
      { id: "ws-wa-573009999999", available: false },
    ],
  };

  test("names each missing tenant so a half-run provisioning is diagnosable", () => {
    expect(unregisteredTenants(payload, ["ws-wa-573001234567"])).toEqual([]);
    expect(unregisteredTenants(payload, ["ws-wa-573000000000"])).toEqual(["ws-wa-573000000000"]);
  });

  test("ONE registered tenant does not vouch for the others", () => {
    // The half-provisioned case. An any-of check passes here, and every
    // unprovisioned sender then shares the engine default workspace — both the
    // collision this change removes AND maximum reach.
    expect(unregisteredTenants(payload, ["ws-wa-573001234567", "ws-wa-573000000000"])).toEqual([
      "ws-wa-573000000000",
    ]);
  });

  test("registered-but-unavailable counts as missing", () => {
    expect(unregisteredTenants(payload, ["ws-wa-573009999999"])).toEqual(["ws-wa-573009999999"]);
  });

  test("the id the check verifies is the id dispatch will use", () => {
    // The drift guard: both sides go through tenantWorkspaceId.
    const principal = { channel: "kapso" as const, id: "573001234567" };
    const viaCheck = tenantWorkspaceId(principal, "ws-wa-");
    const viaDispatch = workspaceDecisionFor(
      `kapso:${Buffer.from("111", "utf8").toString("base64url")}:${Buffer.from("573001234567", "utf8").toString("base64url")}`,
      "ws-wa-",
    );
    expect(viaDispatch).toEqual({ kind: "pin", workspaceId: viaCheck });
  });
});

// ── UX layer (BRO-2256) ────────────────────────────────────────────────────

describe("chunkForWhatsapp sizing", () => {
  test("default target is phone-sized, not API-cap-sized", () => {
    const chunks = chunkForWhatsapp("word ".repeat(600).trim());
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_TARGET);
  });

  test("a target above the transport cap is clamped, not obeyed", () => {
    // Mutation guard: without the clamp this emits ONE 6000-char chunk, which
    // WhatsApp rejects outright and the user never sees.
    const chunks = chunkForWhatsapp("x".repeat(6000), 99_000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(WHATSAPP_TEXT_LIMIT);
  });

  test("a non-positive target falls back instead of looping forever", () => {
    const chunks = chunkForWhatsapp("y".repeat(3000), 0);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_TARGET);
  });
});

describe("keepTyping", () => {
  test("fires immediately and re-arms until stopped", async () => {
    const thread = mockThread("kapso:a:b");
    const stop = keepTyping(thread, 5);
    expect(thread.typingCount).toBe(1); // instant ack, not rearmMs late
    await new Promise((r) => setTimeout(r, 32));
    const during = thread.typingCount;
    expect(during).toBeGreaterThan(1);
    stop();
    await new Promise((r) => setTimeout(r, 25));
    expect(thread.typingCount).toBe(during); // stop() actually stops
  });

  test("a channel without typing support is a no-op, not a throw", () => {
    const bare: PostableThread = { id: "x", async post() {} };
    expect(() => keepTyping(bare, 5)()).not.toThrow();
  });
});

/** A GraphApiError as `@kapso/whatsapp-cloud-api` 0.2.3 actually constructs it:
 *  an Error carrying `code` and `category`, where 131047 -> "reengagementWindow"
 *  comes from the shipped runtime table in dist/index.js. */
function graphApiError(code: number, category: string, message = "Graph API error"): Error {
  return Object.assign(new Error(message), { code, category, httpStatus: 400 });
}

describe("isOutsideServiceWindow", () => {
  test("recognises the real structured re-engagement error", () => {
    expect(isOutsideServiceWindow(graphApiError(131047, "reengagementWindow"))).toBe(true);
  });

  test("recognises it by code even if the category is missing", () => {
    expect(isOutsideServiceWindow(Object.assign(new Error("x"), { code: 131047 }))).toBe(true);
  });

  test("does not swallow an ordinary dispatch failure", () => {
    expect(isOutsideServiceWindow(new Error("ECONNREFUSED"))).toBe(false);
  });

  test("recognises it by CATEGORY even when the code is absent", () => {
    // Without this the category branch is never exercised: every other case
    // that sets category also sets code 131047, so blinding the category
    // match survives. (Mutation sweep, arm `category-match-blinded`.)
    expect(isOutsideServiceWindow({ category: "reengagementWindow" })).toBe(true);
  });

  test("a non-object is not a closed window", () => {
    // The `typeof e !== "object"` guard was unexercised — inverting it to
    // `return true` survived the whole suite.
    for (const v of [undefined, null, "24-hour window", 131047]) {
      expect(isOutsideServiceWindow(v)).toBe(false);
    }
  });

  test("a DIFFERENT Graph error is not mistaken for a closed window", () => {
    // 131026 is "message undeliverable" — a real error that must still surface
    // as a failure, with its ⚠️ and its apology.
    expect(isOutsideServiceWindow(graphApiError(131026, "unknown"))).toBe(false);
  });

  test("MATCHES ON STRUCTURE, NOT WORDING — prose alone is not enough", () => {
    // The regression this replaced. An error whose TEXT contains the phrase but
    // which carries no re-engagement code is an ordinary failure: treating it as
    // a closed window would suppress both the failed status and the apology.
    expect(
      isOutsideServiceWindow(
        new Error("Cannot send non-template messages outside the 24-hour window."),
      ),
    ).toBe(false);
  });
});

describe("turn status signals", () => {
  function recorder() {
    const seen: TurnStatus[] = [];
    return {
      seen,
      signals: {
        async setStatus(s: TurnStatus) {
          seen.push(s);
        },
      },
    };
  }

  test("marks the turn done once it has replied", async () => {
    const thread = mockThread("kapso:a:b");
    const r = recorder();
    await handleAgentMessage(
      thread,
      "hello",
      { baseUrl: "https://x", fetchImpl: okFetch("hi"), streaming: false },
      r.signals,
    );
    expect(r.seen).toEqual(["done"]);
    expect(thread.posts).toEqual(["hi"]);
  });

  test("marks failed when the turn throws", async () => {
    const thread = mockThread("kapso:a:b");
    const r = recorder();
    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await handleAgentMessage(
      thread,
      "hello",
      { baseUrl: "https://x", fetchImpl: boom, streaming: false },
      r.signals,
    );
    expect(r.seen).toEqual(["failed"]);
  });

  test("a closed 24h window is NOT reported as a normal failure", async () => {
    // Thrown from thread.post, which is where this error ACTUALLY originates —
    // the send to WhatsApp, not the Genesis fetch. The first version of this
    // test threw it from fetchImpl, i.e. exercised the right branch from the
    // wrong source.
    //
    // The user cannot be messaged at all in this state, so posting an apology
    // would fail identically. It must stay silent to the thread and loud in the
    // log — and must not claim the turn merely 'failed'.
    const r = recorder();
    const thread: PostableThread = {
      id: "kapso:a:b",
      async startTyping() {},
      async post() {
        throw graphApiError(131047, "reengagementWindow");
      },
    };
    await handleAgentMessage(
      thread,
      "hello",
      { baseUrl: "https://x", fetchImpl: okFetch("hi"), streaming: false },
      r.signals,
    );
    expect(r.seen).toEqual([]);
  });

  test("an ordinary post failure DOES mark failed and apologises", async () => {
    // The polarity partner of the test above. Without it, a change that made
    // isOutsideServiceWindow always-true would still pass.
    const r = recorder();
    let apologised = false;
    let calls = 0;
    const thread: PostableThread = {
      id: "kapso:a:b",
      async startTyping() {},
      async post(content) {
        calls++;
        if (calls === 1) throw new Error("ECONNRESET");
        if (typeof content === "string" && content.includes("⚠️")) apologised = true;
      },
    };
    await handleAgentMessage(
      thread,
      "hello",
      { baseUrl: "https://x", fetchImpl: okFetch("hi"), streaming: false },
      r.signals,
    );
    expect(r.seen).toEqual(["failed"]);
    expect(apologised).toBe(true);
  });

  test("a channel with no signals still completes the turn", async () => {
    const thread = mockThread("tg-1");
    await handleAgentMessage(thread, "hello", {
      baseUrl: "https://x",
      fetchImpl: okFetch("hi"),
      streaming: false,
    });
    expect(thread.posts).toEqual(["hi"]);
  });

  test("every status maps to a distinct emoji", () => {
    const emojis = Object.values(TURN_STATUS_EMOJI);
    expect(new Set(emojis).size).toBe(emojis.length);
  });
});

describe("keepTyping — P20 round 1 hardening", () => {
  test("does not overlap when a call is slower than the re-arm interval", async () => {
    // A slow API must not receive MORE requests than a fast one. The naive
    // version issues a second markRead on top of the first, so the worse the
    // API behaves the harder it is hit.
    let started = 0;
    let release: (() => void) | undefined;
    const thread: PostableThread = {
      id: "kapso:a:b",
      async post() {},
      startTyping() {
        started++;
        return new Promise<void>((r) => {
          release = r;
        });
      },
    };
    const stop = keepTyping(thread, 5);
    await new Promise((r) => setTimeout(r, 40));
    expect(started).toBe(1); // eight intervals elapsed, still one in flight
    release?.();
    stop();
  });

  test("stop() ends re-arming even while a call is in flight", async () => {
    // clearInterval cannot cancel the request already on the wire — nothing
    // can, and no flag inside this function changes that. What it must
    // guarantee is that no FURTHER re-arm is issued once the reply is out.
    let started = 0;
    const thread: PostableThread = {
      id: "kapso:a:b",
      async post() {},
      async startTyping() {
        started++;
        await new Promise((r) => setTimeout(r, 15));
      },
    };
    const stop = keepTyping(thread, 5);
    expect(started).toBe(1);
    stop();
    await new Promise((r) => setTimeout(r, 40));
    expect(started).toBe(1);
  });

  test("stops re-arming at the duration ceiling, bounding request spend", async () => {
    // The rate-budget guard: one turn must not be able to spend the project's
    // whole per-minute quota on saying "still working".
    let started = 0;
    const thread: PostableThread = {
      id: "kapso:a:b",
      async post() {},
      async startTyping() {
        started++;
      },
    };
    const stop = keepTyping(thread, 2, 12);
    await new Promise((r) => setTimeout(r, 60));
    const afterDeadline = started;
    await new Promise((r) => setTimeout(r, 30));
    expect(started).toBe(afterDeadline); // ceiling reached, no further spend
    expect(started).toBeLessThan(12); // and far fewer than the ~30 uncapped
    stop();
  });
});

describe("streaming channels keep their pre-existing indicator", () => {
  /** A fetch that holds the turn open long enough for several re-arms. */
  function slowFetch(reply: string, ms: number): typeof fetch {
    return (async () => {
      await new Promise((r) => setTimeout(r, ms));
      return new Response(
        sseBody([
          part({ type: "text-start", id: "t" }),
          part({ type: "text-delta", id: "t", delta: reply }),
          part({ type: "text-end", id: "t" }),
          part({ type: "finish" }),
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
  }

  test("a STREAMING channel gets exactly ONE indicator across a long turn", async () => {
    // Telegram's behaviour must be unchanged: the stream itself is the progress
    // display, so re-arming there would be a behaviour change this PR claims
    // not to make. The long turn is what makes this falsifiable — at the 20s
    // production interval a fast test cannot tell one indicator from a
    // keep-alive, and removing the buffered gate SURVIVED the earlier version.
    const thread = mockThread("tg-1");
    await handleAgentMessage(thread, "hello", {
      baseUrl: "https://x",
      fetchImpl: slowFetch("hi", 40),
      typingRearmMs: 5,
    });
    expect(thread.typingCount).toBe(1);
  });

  test("a BUFFERED channel re-arms across the same long turn", async () => {
    // The polarity partner. Without it, "streaming gets one" would also pass if
    // the keep-alive were broken for everyone.
    const thread = mockThread("kapso:a:b");
    await handleAgentMessage(thread, "hello", {
      baseUrl: "https://x",
      fetchImpl: slowFetch("hi", 40),
      streaming: false,
      typingRearmMs: 5,
    });
    expect(thread.typingCount).toBeGreaterThan(1);
  });
});

describe("chunkForWhatsapp — fractional limits", () => {
  test("a fractional limit below 1 does not hang the event loop", () => {
    // 0.5 passes a `> 0` check, then slice(0, 0.5) consumes zero characters and
    // the loop never terminates. Flooring to a minimum of 1 is what makes every
    // accepted limit one that actually advances.
    const chunks = chunkForWhatsapp("abcdef", 0.5);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toContain("a");
  });

  test("a fractional limit above 1 floors rather than slicing fractionally", () => {
    const chunks = chunkForWhatsapp("z".repeat(20), 4.9);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4);
  });
});

describe("P20 round 2 — status ordering and the shared budget", () => {
  test("exactly ONE status call per turn — nothing can arrive out of order", async () => {
    // The structural answer to the ordering race: a single terminal call has
    // nothing to race against. An abandoned-but-uncancelled earlier reaction
    // was the defect; there is no earlier reaction now.
    const applied: TurnStatus[] = [];
    const signals = {
      async setStatus(s: TurnStatus) {
        applied.push(s);
      },
    };
    const thread = mockThread("kapso:a:b");
    await handleAgentMessage(
      thread,
      "hello",
      { baseUrl: "https://x", fetchImpl: okFetch("hi"), streaming: false },
      signals,
    );
    expect(applied).toEqual(["done"]);
  });

  test("a NEVER-SETTLING status cannot block the terminal status", async () => {
    // Sequencing fixed ordering but created a liveness hazard: the chain awaits
    // each link, so a 'working' that never resolves would hold the terminal
    // status — and the apology — forever. Feedback must never withhold the
    // product.
    const thread = mockThread("kapso:a:b");
    const started = Date.now();
    await handleAgentMessage(
      thread,
      "hello",
      {
        baseUrl: "https://x",
        fetchImpl: okFetch("the answer"),
        streaming: false,
        statusTimeoutMs: 40,
      },
      { setStatus: () => new Promise<void>(() => {}) },
    );
    expect(thread.posts).toEqual(["the answer"]); // reply still delivered
    expect(Date.now() - started).toBeLessThan(2_000); // bounded by statusTimeoutMs, not by the hung promise
  });

  test("a hung status cannot block the APOLOGY on the failure path", async () => {
    const posts: string[] = [];
    const thread: PostableThread = {
      id: "kapso:a:b",
      async startTyping() {},
      async post(c) {
        if (typeof c === "string") posts.push(c);
      },
    };
    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await handleAgentMessage(
      thread,
      "hello",
      { baseUrl: "https://x", fetchImpl: boom, streaming: false, statusTimeoutMs: 40 },
      { setStatus: () => new Promise<void>(() => {}) },
    );
    expect(posts.some((p) => p.includes("\u26a0\ufe0f"))).toBe(true);
  });
});

describe("BRO-2267 — markdown is converted before it reaches WhatsApp", () => {
  test("the buffered path converts; nothing raw reaches the channel", async () => {
    // Wiring guard driven through the REAL handler, not by grepping source: a
    // converter that exists and is never called is the defect this repo keeps
    // shipping.
    const thread = mockThread("kapso:a:b");
    const md = "## Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n**bold**";
    await handleAgentMessage(thread, "go", {
      baseUrl: "https://x",
      fetchImpl: okFetch(md),
      streaming: false,
    });
    const sent = thread.posts.join("\n");
    expect(sent).not.toMatch(/^#{1,6}\s/m); // no heading hashes
    expect(sent).not.toContain("|---|"); // no alignment row
    expect(sent).not.toContain("**"); // no stray double asterisks
    expect(sent).toContain("*Title*"); // heading became bold
    expect(sent).toContain("*bold*");
  });

  test("a STREAMING channel is left alone — Telegram renders markdown itself", async () => {
    // Polarity partner. Converting for Telegram would DOWNGRADE it: it has real
    // headings and tables, and WhatsApp syntax is not its syntax.
    const thread = mockThread("tg-1");
    await handleAgentMessage(thread, "go", {
      baseUrl: "https://x",
      fetchImpl: okFetch("## Title\n\n**bold**"),
    });
    expect(thread.posts.join("\n")).toContain("## Title");
  });
});
