// HANDLER-LEVEL end-to-end tests, against real sockets (BRO-2245).
//
// WHY A SEPARATE FILE FROM dispatch-failure.e2e.test.ts. That suite composes
// genesisStream + withStallTimeout + classifyDispatchFailure BY HAND. Cross-model
// review pointed out the consequence: deleting the wiring in `handleAgentMessage`
// leaves every one of those tests green, because none of them call it. The pieces
// were tested; the product was not.
//
// These call `handleAgentMessage` and assert on what a TENANT ACTUALLY RECEIVES.
// Each is mutation-checked by deleting the production wiring — see the PR body.
import { afterAll, describe, expect, test } from "bun:test";
import { type PostableThread, handleAgentMessage } from "./handler";

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

/** Collects what was posted, mirroring the buffered (WhatsApp) path. */
function recordingThread(id = "t"): PostableThread & { posts: string[] } {
  const posts: string[] = [];
  return {
    id,
    posts,
    async post(content) {
      if (typeof content === "string") posts.push(content);
      else for await (const c of content as AsyncIterable<string>) posts.push(c);
      return undefined;
    },
  };
}

/** SSE frames, then optional permanent silence. */
function sseServer(frames: string[], thenHang: boolean) {
  const server = Bun.serve({
    port: 0,
    fetch() {
      const body = new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          for (const f of frames) c.enqueue(enc.encode(f));
          if (!thenHang) c.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  servers.push(server);
  return server;
}

const START = 'data: {"type":"start"}\n\n';
const textFrames = (s: string) => [
  START,
  'data: {"type":"text-start"}\n\n',
  `data: {"type":"text-delta","delta":${JSON.stringify(s)}}\n\n`,
];

describe("handleAgentMessage — failure 1: backend DOWN", () => {
  test("tenant is told the BACKEND is unreachable, not a generic error", async () => {
    const thread = recordingThread();
    // A port that is bound and then released: deterministic, unlike assuming
    // port 1 is free.
    const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const deadPort = probe.port;
    probe.stop(true);

    await handleAgentMessage(thread, "hi", {
      baseUrl: `http://127.0.0.1:${deadPort}`,
      streaming: false,
    });

    expect(thread.posts).toHaveLength(1);
    expect(thread.posts[0]).toContain("not reachable");
    // The old catch-all must NOT be what a tenant sees for this.
    expect(thread.posts[0]).not.toBe("⚠️ Something went wrong handling that — please try again.");
  }, 20_000);
});

describe("handleAgentMessage — failure 2: stream opens, then silence", () => {
  test("tenant gets a TIMEOUT message instead of silence forever", async () => {
    const server = sseServer([START], true);
    const thread = recordingThread();

    await handleAgentMessage(thread, "hi", {
      baseUrl: `http://127.0.0.1:${server.port}`,
      streaming: false,
      stallMs: 200,
    });

    expect(thread.posts).toHaveLength(1);
    expect(thread.posts[0]).toContain("did not respond in time");
  }, 20_000);

  // The two incident failures, through the real handler, must differ.
  test("the two failures produce DIFFERENT tenant messages", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const deadPort = probe.port;
    probe.stop(true);
    const down = recordingThread();
    await handleAgentMessage(down, "hi", {
      baseUrl: `http://127.0.0.1:${deadPort}`,
      streaming: false,
    });

    const server = sseServer([START], true);
    const hung = recordingThread();
    await handleAgentMessage(hung, "hi", {
      baseUrl: `http://127.0.0.1:${server.port}`,
      streaming: false,
      stallMs: 200,
    });

    expect(down.posts[0]).not.toBe(hung.posts[0]);
  }, 25_000);
});

describe("handleAgentMessage — a HEALTHY turn is never cut off", () => {
  // The overshoot guard. genesisStream yields only text frames, so a turn inside a
  // long tool call emits nothing while being alive. Liveness comes from SSE
  // ACTIVITY, so non-text frames must keep it alive well past the window.
  test("non-text frames keep a turn alive past the stall window", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const body = new ReadableStream({
          async start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode(START));
            // 6 quiet-but-active frames across ~360ms, window is 120ms. A
            // yield-based bound would kill this; an activity-based one must not.
            for (let i = 0; i < 6; i++) {
              await new Promise((r) => setTimeout(r, 60));
              c.enqueue(enc.encode(`data: {"type":"tool-call","id":"${i}"}\n\n`));
            }
            c.enqueue(enc.encode('data: {"type":"text-start"}\n\n'));
            c.enqueue(enc.encode('data: {"type":"text-delta","delta":"done"}\n\n'));
            c.close();
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push(server);

    const thread = recordingThread();
    await handleAgentMessage(thread, "hi", {
      baseUrl: `http://127.0.0.1:${server.port}`,
      streaming: false,
      stallMs: 120,
    });

    expect(thread.posts.join("")).toContain("done");
    expect(thread.posts.join("")).not.toContain("⚠️");
  }, 20_000);

  test("an ordinary fast turn is delivered unchanged", async () => {
    const server = sseServer(textFrames("hello world"), false);
    const thread = recordingThread();
    await handleAgentMessage(thread, "hi", {
      baseUrl: `http://127.0.0.1:${server.port}`,
      streaming: false,
      stallMs: 5000,
    });
    expect(thread.posts.join("")).toBe("hello world");
  }, 20_000);
});

describe("handleAgentMessage — a stall CLOSES the socket", () => {
  test("the server observes the request aborted", async () => {
    let aborted = false;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        req.signal.addEventListener("abort", () => {
          aborted = true;
        });
        const body = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(START));
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push(server);

    const thread = recordingThread();
    await handleAgentMessage(thread, "hi", {
      baseUrl: `http://127.0.0.1:${server.port}`,
      streaming: false,
      stallMs: 150,
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(aborted).toBe(true);
  }, 20_000);
});

describe("handleAgentMessage — an agent error is attributed to the AGENT", () => {
  test("an SSE error frame yields the agent-error message, and leaks nothing", async () => {
    const server = sseServer(
      [START, 'data: {"type":"error","errorText":"secret-token-abc123 blew up"}\n\n'],
      false,
    );
    const thread = recordingThread();
    await handleAgentMessage(thread, "hi", {
      baseUrl: `http://127.0.0.1:${server.port}`,
      streaming: false,
    });
    expect(thread.posts[0]).toContain("The agent failed");
    expect(thread.posts[0]).not.toContain("secret-token-abc123");
  }, 20_000);
});
