// END-TO-END regression for the two failures of the 2026-08-23 srv1692698 outage.
//
// These drive REAL sockets through the REAL `genesisStream`, and classify whatever
// it actually throws. The unit tests next door construct error objects, and that
// is exactly how the first version of this classifier shipped broken: it was built
// and tested against Node-shaped errors while the bot runs on Bun, which throws a
// plain `Error` with a bun-native `code` and no cause chain. Every assertion here
// would have failed on that version.
import { afterAll, describe, expect, test } from "bun:test";
import {
  type DispatchFailure,
  classifyDispatchFailure,
  dispatchFailureMessage,
} from "./dispatch-failure";
import { genesisStream } from "./genesis";
import { withStallTimeout } from "./stall-timeout";

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

async function drain(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const c of gen) out += c;
  return out;
}

/** Capture what the dispatch path actually throws, or null if it did not throw. */
async function failureOf(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

describe("E2E — failure 1: genesis-api is DOWN (17:09-18:5x)", () => {
  test("a refused port classifies as backend-unreachable", async () => {
    // Port 1 is reserved and never listening.
    const e = await failureOf(() =>
      drain(genesisStream({ baseUrl: "http://127.0.0.1:1", threadId: "t", text: "hi" })),
    );
    expect(e).not.toBeNull();
    expect(classifyDispatchFailure(e)).toBe("backend-unreachable");
  });
});

describe("E2E — failure 2: api UP, stream opens then goes silent (18:5x->)", () => {
  test("200 + stream header + permanent silence classifies as timeout", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        // Exactly what was measured: headers, one frame, then nothing, forever.
        const body = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n'));
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push(server);

    const e = await failureOf(() =>
      drain(
        withStallTimeout(
          genesisStream({ baseUrl: `http://127.0.0.1:${server.port}`, threadId: "t", text: "hi" }),
          150,
        ),
      ),
    );
    expect(e).not.toBeNull();
    expect(classifyDispatchFailure(e)).toBe("timeout");
  }, 15_000);

  // Without the stall bound this case never throws at all — the dispatch hangs,
  // the catch never runs, and the channel says nothing. That was the state during
  // the incident, and it is what makes the bound load-bearing rather than tidy.
  test("WITHOUT the stall bound the same server hangs instead of failing", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const body = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n'));
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    // NOT pushed to `servers`: this test leaves a deliberately never-settling
    // fetch in flight, so the server must be force-stopped HERE. Deferring to
    // afterAll leaves the dangling request holding the suite open — which is the
    // same "hangs instead of failing" property the test is asserting, turned on
    // the test runner itself.
    const raced = await Promise.race([
      drain(
        genesisStream({ baseUrl: `http://127.0.0.1:${server.port}`, threadId: "t", text: "hi" }),
      )
        .then(() => "completed")
        .catch(() => "threw"),
      new Promise<string>((r) => setTimeout(() => r("still-hanging"), 400)),
    ]);
    server.stop(true);
    expect(raced).toBe("still-hanging");
  }, 15_000);
});

describe("E2E — a stall actually CLOSES the connection", () => {
  // The property that matters operationally. Ending the generator is not enough:
  // a generator suspended on a never-settling await cannot run its own cleanup, so
  // without the AbortController the request stays open and the socket leaks. A
  // hung dispatch holding its connection is what exhausted the host on 2026-08-23.
  test("the SERVER observes the request being aborted", async () => {
    let aborted = false;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        req.signal.addEventListener("abort", () => {
          aborted = true;
        });
        const body = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n'));
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });

    const ac = new AbortController();
    const e = await failureOf(() =>
      drain(
        withStallTimeout(
          genesisStream({
            baseUrl: `http://127.0.0.1:${server.port}`,
            threadId: "t",
            text: "hi",
            signal: ac.signal,
          }),
          150,
          { onStall: () => ac.abort() },
        ),
      ),
    );
    expect(classifyDispatchFailure(e)).toBe("timeout");
    // Give the abort a tick to reach the server before asserting.
    await new Promise((r) => setTimeout(r, 100));
    expect(aborted).toBe(true);
    server.stop(true);
  }, 15_000);
});

describe("E2E — the two incident failures are DISTINGUISHABLE", () => {
  test("different class AND different tenant-visible message", async () => {
    const down = await failureOf(() =>
      drain(genesisStream({ baseUrl: "http://127.0.0.1:1", threadId: "t", text: "hi" })),
    );

    const server = Bun.serve({
      port: 0,
      fetch() {
        const body = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n'));
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push(server);
    const hung = await failureOf(() =>
      drain(
        withStallTimeout(
          genesisStream({ baseUrl: `http://127.0.0.1:${server.port}`, threadId: "t", text: "hi" }),
          150,
        ),
      ),
    );

    const a = classifyDispatchFailure(down);
    const b = classifyDispatchFailure(hung);
    expect(a).not.toBe(b);
    expect(dispatchFailureMessage(a)).not.toBe(dispatchFailureMessage(b));
    // Neither may fall back to the original catch-all, which is the state this
    // whole change exists to leave behind.
    expect([a, b]).not.toContain("unknown");
  }, 15_000);
});

describe("E2E — real HTTP statuses through genesisStream", () => {
  // Typed explicitly: an inferred (number|string)[][] widens `expected` to string
  // and TS then rejects the toBe against the DispatchFailure union.
  const CASES: Array<[number, DispatchFailure]> = [
    [401, "unauthorized"],
    [403, "unauthorized"],
    [500, "backend-error"],
    [502, "backend-error"],
  ];
  test.each(CASES)("HTTP %d -> %s", async (status, expected) => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("x", { status }) });
    servers.push(server);
    const e = await failureOf(() =>
      drain(
        genesisStream({ baseUrl: `http://127.0.0.1:${server.port}`, threadId: "t", text: "hi" }),
      ),
    );
    expect(classifyDispatchFailure(e)).toBe(expected);
  });
});

describe("E2E — an agent error part is attributed to the AGENT", () => {
  test("an SSE error frame classifies as agent-error, not unknown", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode('data: {"type":"start"}\n\n'));
            c.enqueue(enc.encode('data: {"type":"error","errorText":"tool blew up"}\n\n'));
            c.close();
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push(server);
    const e = await failureOf(() =>
      drain(
        genesisStream({ baseUrl: `http://127.0.0.1:${server.port}`, threadId: "t", text: "hi" }),
      ),
    );
    expect(classifyDispatchFailure(e)).toBe("agent-error");
    // ...and the agent's own text still never reaches the channel.
    expect(dispatchFailureMessage("agent-error")).not.toContain("tool blew up");
  }, 15_000);
});
