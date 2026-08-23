#!/usr/bin/env bun
// Capture the SHAPES this runtime's fetch actually throws (BRO-2245).
//
// dispatch-failure.ts classifies errors by `code`/`name`. Its first version listed
// Node errnos and was tested against hand-built Node-shaped errors — it passed,
// while misclassifying the real runtime: bun does not throw a TypeError with an
// errno cause, it throws a plain Error with a bun-native `code`. Tests that
// construct the shape they expect cannot catch that; only capture can.
//
//   bun scripts/capture-fetch-shapes.ts
//
// Run this after a runtime upgrade and reconcile CONNECT_CODES with the output.

function shape(label: string, e: unknown): void {
  const chain: string[] = [];
  let cur: unknown = e;
  for (let i = 0; cur && i < 4; i++) {
    const c = cur as {
      constructor?: { name?: string };
      name?: string;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    chain.push(
      `${c.constructor?.name}|name=${c.name}|code=${String(c.code)}|msg=${String(c.message).slice(0, 60)}`,
    );
    cur = c.cause;
  }
  console.log(`${label.padEnd(18)} -> ${chain.join("  ||  ")}`);
}

async function capture(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    console.log(`${label.padEnd(18)} -> NO THROW`);
  } catch (e) {
    shape(label, e);
  }
}

await capture("refused-port", () => fetch("http://127.0.0.1:1/x"));
await capture("bad-dns", () => fetch("http://no-such-host-xyz-abc.invalid/"));

// A server that answers, streams a header frame, then stays silent forever — the
// shape observed on srv1692698 at 18:5x UTC on 2026-08-23.
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
await capture("open-then-silent", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/`, { signal: AbortSignal.timeout(150) });
  const reader = (res.body as ReadableStream).getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
});
server.stop(true);

// Top-level await needs this file to be a module.
export {};
