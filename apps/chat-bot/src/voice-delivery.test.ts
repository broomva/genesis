import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HANDLED_FILE,
  MAX_ATTEMPTS,
  type VoiceTicket,
  appendHandled,
  deliverTicket,
  drainOnce,
  parseQueue,
  pendingTickets,
  readHandled,
  terminalIds,
} from "./voice-delivery";

const dirs: string[] = [];
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "voice-deliv-")));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ticket = (over: Partial<VoiceTicket> = {}): VoiceTicket => ({
  id: "v-1",
  callerId: "573017758620",
  deliverTo: "573017758620",
  request: "send the August invoice",
  createdAt: "2026-08-24T01:00:00.000Z",
  ...over,
});

function writeQueue(dir: string, tickets: object[]): string {
  mkdirSync(join(dir, "voice"), { recursive: true });
  const p = join(dir, "voice", "queue.jsonl");
  for (const t of tickets) appendFileSync(p, `${JSON.stringify(t)}\n`);
  return join(dir, "voice");
}

describe("parseQueue — reads a file another process is appending to", () => {
  test("parses whole tickets", () => {
    const raw = `${JSON.stringify(ticket())}\n${JSON.stringify(ticket({ id: "v-2" }))}\n`;
    const { tickets, skipped } = parseQueue(raw);
    expect(tickets.map((t) => t.id)).toEqual(["v-1", "v-2"]);
    expect(skipped).toBe(0);
  });

  test("a TRUNCATED last line does not lose the complete ones before it", () => {
    // The producer appends while we read; the tail can be half-written.
    const raw = `${JSON.stringify(ticket())}\n${JSON.stringify(ticket({ id: "v-2" })).slice(0, 30)}`;
    const { tickets, skipped } = parseQueue(raw);
    expect(tickets.map((t) => t.id)).toEqual(["v-1"]);
    expect(skipped).toBe(1);
  });

  test("one malformed line does not stop every later ticket from being answered", () => {
    const raw = `not json\n${JSON.stringify(ticket({ id: "v-9" }))}\n`;
    const { tickets, skipped } = parseQueue(raw);
    expect(tickets.map((t) => t.id)).toEqual(["v-9"]);
    expect(skipped).toBe(1);
  });

  test("json that is not a ticket shape is skipped, not half-processed", () => {
    const { tickets, skipped } = parseQueue('{"id":"x"}\n{"hello":1}\n[]\nnull\n');
    expect(tickets).toEqual([]);
    expect(skipped).toBe(4);
  });
});

describe("pendingTickets", () => {
  test("collapses a STABLE id appearing twice (the provider retry)", () => {
    // voice.ts derives the id from conversationId+request precisely so a retry
    // lands on the same ticket. Collapsing here is what makes that harmless.
    const out = pendingTickets([ticket(), ticket()], new Set());
    expect(out).toHaveLength(1);
  });

  test("skips ids already terminal", () => {
    expect(pendingTickets([ticket(), ticket({ id: "v-2" })], new Set(["v-1"]))).toHaveLength(1);
  });

  test("preserves order, so two asks are answered as they were made", () => {
    const out = pendingTickets([ticket({ id: "a" }), ticket({ id: "b" })], new Set());
    expect(out.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("terminalIds — what must never be attempted again", () => {
  const entry = (id: string, disposition: string, attempts: number) => ({
    id,
    at: "now",
    disposition,
    attempts,
  });

  test("delivered and undeliverable are terminal", () => {
    const m = new Map([
      ["a", entry("a", "delivered", 1)],
      ["b", entry("b", "undeliverable", 1)],
    ]);
    expect([...terminalIds(m)].sort()).toEqual(["a", "b"]);
  });

  test("a failure UNDER the cap is retried; at the cap it is abandoned", () => {
    const m = new Map([
      ["u", entry("u", "failed:send", MAX_ATTEMPTS - 1)],
      ["c", entry("c", "failed:send", MAX_ATTEMPTS)],
    ]);
    const t = terminalIds(m);
    expect(t.has("u")).toBe(false);
    expect(t.has("c")).toBe(true);
  });
});

describe("deliverTicket", () => {
  const deps = (over: Partial<Parameters<typeof deliverTicket>[1]> = {}) => ({
    dispatch: async () => "the invoice is attached",
    send: async () => {},
    workspaceFor: (to: string) => `wa-${to}`,
    ...over,
  });

  test("an unrecognized caller is UNDELIVERABLE, and nothing is sent", async () => {
    let sent = 0;
    const d = await deliverTicket(
      ticket({ deliverTo: undefined }),
      deps({
        send: async () => {
          sent++;
        },
      }) as never,
    );
    expect(d).toEqual({ kind: "undeliverable", reason: "no-recipient" });
    expect(sent).toBe(0);
  });

  test("the turn runs in the CALLER'S tenant workspace, not the default", async () => {
    // Confinement, not convenience: a voice request must be as sandboxed as the
    // same person's WhatsApp turn.
    let got: string | undefined = "unset";
    await deliverTicket(
      ticket(),
      deps({
        dispatch: async (_t, ws) => {
          got = ws;
          return "ok";
        },
      }) as never,
    );
    expect(got).toBe("wa-573017758620");
  });

  test("a dispatch failure does NOT send anything", async () => {
    let sent = 0;
    const d = await deliverTicket(
      ticket(),
      deps({
        dispatch: async () => {
          throw new Error("engine down");
        },
        send: async () => {
          sent++;
        },
      }) as never,
    );
    expect(d.kind).toBe("failed");
    expect((d as { reason: string }).reason).toBe("dispatch");
    expect(sent).toBe(0);
  });

  test("a CLOSED 24h window is classified specifically, not as a generic failure", async () => {
    // Structural, matching handler.ts: code 131047 / category reengagementWindow.
    const err = Object.assign(new Error("boom"), { code: 131047 });
    const d = await deliverTicket(
      ticket(),
      deps({
        send: async () => {
          throw err;
        },
      }) as never,
    );
    expect(d).toMatchObject({ kind: "failed", reason: "window-closed" });
  });

  test("an ordinary send failure stays 'send', so it is not excused as a closed window", async () => {
    const d = await deliverTicket(
      ticket(),
      deps({
        send: async () => {
          throw new Error("socket hang up");
        },
      }) as never,
    );
    expect(d).toMatchObject({ kind: "failed", reason: "send" });
  });

  test("an empty answer still sends something — silence reads as a dropped request", async () => {
    let body = "";
    const d = await deliverTicket(
      ticket(),
      deps({
        dispatch: async () => "   ",
        send: async (_to: string, text: string) => {
          body = text;
        },
      }) as never,
    );
    expect(d.kind).toBe("delivered");
    expect(body).toContain("without producing any text");
  });
});

describe("drainOnce", () => {
  const base = (over = {}) => ({
    dispatch: async () => "answer",
    send: async () => {},
    workspaceFor: (to: string) => `wa-${to}`,
    now: () => "2026-08-24T00:00:00.000Z",
    ...over,
  });

  test("delivers a pending ticket and records it", async () => {
    const dir = tmp();
    const qd = writeQueue(dir, [ticket()]);
    const r = await drainOnce({ queueDir: qd, ...base() } as never);
    expect(r).toMatchObject({ scanned: 1, attempted: 1, delivered: 1, failed: 0 });
    const handled = readHandled(join(qd, HANDLED_FILE));
    expect(handled.get("v-1")?.disposition).toBe("delivered");
  });

  test("a second pass does NOT redeliver", async () => {
    const dir = tmp();
    const qd = writeQueue(dir, [ticket()]);
    let sends = 0;
    const deps = base({
      send: async () => {
        sends++;
      },
    });
    await drainOnce({ queueDir: qd, ...deps } as never);
    const second = await drainOnce({ queueDir: qd, ...deps } as never);
    expect(sends).toBe(1);
    expect(second.attempted).toBe(0);
  });

  test("the ticket is recorded AFTER the send, never before", async () => {
    // At-least-once is deliberate: a crash between send and record redelivers,
    // and a duplicate answer beats silence. Recording FIRST would lose it.
    const dir = tmp();
    const qd = writeQueue(dir, [ticket()]);
    let handledAtSendTime = 0;
    await drainOnce({
      queueDir: qd,
      ...base({
        send: async () => {
          handledAtSendTime = readHandled(join(qd, HANDLED_FILE)).size;
        },
      }),
    } as never);
    expect(handledAtSendTime).toBe(0);
    expect(readHandled(join(qd, HANDLED_FILE)).size).toBe(1);
  });

  test("a failing ticket retries, then is ABANDONED at the cap", async () => {
    const dir = tmp();
    const qd = writeQueue(dir, [ticket()]);
    let attempts = 0;
    const deps = base({
      send: async () => {
        attempts++;
        throw new Error("nope");
      },
    });
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      await drainOnce({ queueDir: qd, ...deps } as never);
    }
    // Every attempt re-runs the agent turn, so an uncapped retry would burn
    // compute forever against a permanently closed window.
    expect(attempts).toBe(MAX_ATTEMPTS);
  });

  test("an undeliverable ticket is recorded once and never retried", async () => {
    const dir = tmp();
    const qd = writeQueue(dir, [ticket({ deliverTo: undefined })]);
    const deps = base();
    await drainOnce({ queueDir: qd, ...deps } as never);
    const second = await drainOnce({ queueDir: qd, ...deps } as never);
    expect(second.attempted).toBe(0);
    expect(readHandled(join(qd, HANDLED_FILE)).get("v-1")?.disposition).toBe("undeliverable");
  });

  test("a missing queue file is not an error", async () => {
    const r = await drainOnce({ queueDir: join(tmp(), "nope"), ...base() } as never);
    expect(r).toMatchObject({ scanned: 0, attempted: 0 });
  });

  test("a corrupt handled line loses one id's history, not the whole file", async () => {
    const dir = tmp();
    const qd = writeQueue(dir, [ticket()]);
    appendHandled(join(qd, HANDLED_FILE), {
      id: "other",
      at: "t",
      disposition: "delivered",
      attempts: 1,
    });
    appendFileSync(join(qd, HANDLED_FILE), "{corrupt\n");
    expect(readHandled(join(qd, HANDLED_FILE)).has("other")).toBe(true);
  });
});
