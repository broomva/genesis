import { afterEach, describe, expect, test } from "bun:test";
import { fetchThreads } from "./threads";

/**
 * The drawer must still see every thread now that the engine bounds a response.
 *
 * This exists because the bound shipped first and the consumer did not: the BFF
 * proxied a LITERAL "/threads", dropping `?offset=`, so the engine's page was
 * unreachable through the only route the browser has. The deployed box had 226
 * threads at the time, and the drawer filters archived and searches CLIENT-SIDE
 * over what it already holds — so thread 201 was invisible to search as well as
 * to scroll. A size bound had become a correctness bug.
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A server holding `total` threads and honouring limit/offset + hasMore. */
function serverWith(total: number) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://x");
    calls.push(url.search);
    const limit = Number(url.searchParams.get("limit") ?? 200);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const threads = Array.from(
      { length: Math.max(0, Math.min(limit, total - offset)) },
      (_, i) => ({
        threadId: `t-${offset + i}`,
      }),
    );
    return new Response(
      JSON.stringify({ threads, total, hasMore: offset + threads.length < total }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { calls: () => calls };
}

describe("fetchThreads pages", () => {
  test("reaches thread 226 — past the engine's 200 cap", () => {
    const s = serverWith(226);
    return fetchThreads().then((all) => {
      expect(all.length).toBe(226);
      expect(all.at(-1)?.threadId).toBe("t-225");
      // Two requests, and the second one carries an offset — the thing the BFF
      // used to drop.
      expect(s.calls().length).toBe(2);
      expect(s.calls()[1]).toContain("offset=200");
    });
  });

  test("a single page ends the loop — no wasted request", () => {
    const s = serverWith(5);
    return fetchThreads().then((all) => {
      expect(all.length).toBe(5);
      expect(s.calls().length).toBe(1);
    });
  });

  test("a server that always claims hasMore cannot spin forever", () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ threads: [{ threadId: `t-${calls}` }], hasMore: true }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    return fetchThreads().then((all) => {
      expect(calls).toBe(25); // the runaway guard, not a display limit
      expect(all.length).toBe(25);
    });
  });

  test("an empty page ends the loop even when hasMore lies", () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ threads: [], hasMore: true }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return fetchThreads().then((all) => {
      expect(calls).toBe(1);
      expect(all).toEqual([]);
    });
  });

  test("a later page failing keeps the pages already fetched", () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1)
        return new Response(
          JSON.stringify({ threads: [{ threadId: "t-0" }], total: 2, hasMore: true }),
          { headers: { "content-type": "application/json" } },
        );
      return new Response("boom", { status: 500 });
    }) as typeof fetch;
    return fetchThreads().then((all) => {
      expect(all.map((t) => t.threadId)).toEqual(["t-0"]);
    });
  });
});
