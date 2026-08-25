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
import { CHUNK_TARGET, renderForWhatsapp } from "./handler";
import {
  HANDLED_FILE,
  MAX_ATTEMPTS,
  type VoiceTicket,
  appendHandled,
  createVoiceSender,
  deliverTicket,
  drainOnce,
  parseQueue,
  pendingTickets,
  readHandled,
  terminalIds,
  voiceSendChunks,
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

  test("the ticket is recorded only after the send RESOLVES", async () => {
    // At-least-once is deliberate: a crash between send and record redelivers,
    // and a duplicate answer beats silence.
    //
    // The first version of this only checked that no record existed when `send`
    // was INVOKED — which an implementation that fires a deferred send, records
    // the id, then awaits would have passed while being exactly wrong. So this
    // holds the send open and asserts nothing is recorded until it settles.
    const dir = tmp();
    const qd = writeQueue(dir, [ticket()]);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let atInvoke = -1;
    let midFlight = -1;
    const done = drainOnce({
      queueDir: qd,
      ...base({
        send: async () => {
          atInvoke = readHandled(join(qd, HANDLED_FILE)).size;
          await gate;
        },
      }),
    } as never);
    await Promise.resolve();
    midFlight = readHandled(join(qd, HANDLED_FILE)).size;
    release();
    await done;
    expect(atInvoke).toBe(0);
    expect(midFlight).toBe(0); // still nothing while the send is in flight
    expect(readHandled(join(qd, HANDLED_FILE)).size).toBe(1);
  });

  test("a FAILED send is never recorded as delivered", async () => {
    // The polarity the ordering test cannot show on its own.
    const dir = tmp();
    const qd = writeQueue(dir, [ticket()]);
    await drainOnce({
      queueDir: qd,
      ...base({
        send: async () => {
          throw new Error("nope");
        },
      }),
    } as never);
    expect(readHandled(join(qd, HANDLED_FILE)).get("v-1")?.disposition).toBe("failed:send");
  });

  test("a failing ticket retries, then is ABANDONED at the cap", async () => {
    const dir = tmp();
    const qd = writeQueue(dir, [ticket()]);
    // Counts DISPATCHES, not sends. The cost being bounded is the agent turn;
    // counting sends measured the cheap half and would have passed even if
    // dispatch ran on every poll forever.
    let dispatches = 0;
    const deps = base({
      dispatch: async () => {
        dispatches++;
        return "answer";
      },
      send: async () => {
        throw new Error("nope");
      },
    });
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      await drainOnce({ queueDir: qd, ...deps } as never);
    }
    expect(dispatches).toBe(MAX_ATTEMPTS);
  });

  test("the cap holds even when the outcome CANNOT be written down", async () => {
    // A read-only volume used to mean the attempt was forgotten and the paid turn
    // re-ran on every poll, forever — the cap bounding nothing at all.
    const dir = tmp();
    const qd = writeQueue(dir, [ticket()]);
    mkdirSync(join(qd, HANDLED_FILE), { recursive: true }); // appending now fails
    let dispatches = 0;
    const attemptMemo = new Map<string, number>();
    const deps = base({
      dispatch: async () => {
        dispatches++;
        return "answer";
      },
      send: async () => {
        throw new Error("nope");
      },
    });
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      await drainOnce({ queueDir: qd, attemptMemo, ...deps } as never);
    }
    expect(dispatches).toBe(MAX_ATTEMPTS);
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

describe("voiceSendChunks — the voice leg renders exactly as the WhatsApp handler", () => {
  // Pins the invariant the extraction exists for. A mutation giving the voice
  // path a different chunk target previously passed the whole suite, because the
  // send closure lives inside startVoiceDelivery() and no test could reach it.
  const replies = [
    "## Summary\n\n**done** — see [docs](https://example.com/x)",
    "| a | b |\n|---|---|\n| 1 | 2 |",
    "```python\ndef f(*a, **kw): pass\n```",
    `long: ${"lorem ipsum dolor sit amet. ".repeat(120)}`,
    "• *already converted* — run `/parallax`",
  ];
  for (const [i, text] of replies.entries()) {
    test(`case ${i}: identical to renderForWhatsapp's chunks`, () => {
      expect(voiceSendChunks(text, "v-1")).toEqual(
        renderForWhatsapp(text, { label: "thread=t", warn: () => {} }).chunks,
      );
    });
  }
  test("falls back to the raw text when the render produces nothing", () => {
    // Silence is indistinguishable from the system dropping the request.
    expect(voiceSendChunks("", "v-1")).toEqual([""]);
  });
  test("never returns an empty list", () => {
    for (const t of [...replies, "", "   "]) {
      expect(voiceSendChunks(t, "v-1").length).toBeGreaterThan(0);
    }
  });
});

describe("createVoiceSender — what actually reaches sendText", () => {
  // Review of the first attempt: extracting only the RENDERING moved the
  // untestable boundary up a level. index.ts could still have sent `[text]`
  // and every test would pass. This observes the boundary that matters.
  const fake = () => {
    const sent: Array<{ to: string; body: string }> = [];
    return {
      sent,
      wa: {
        messages: {
          sendText: async (m: { phoneNumberId: string; to: string; body: string }) => {
            sent.push({ to: m.to, body: m.body });
            return {};
          },
        },
      },
    };
  };

  test("the bodies are exactly voiceSendChunks' output", async () => {
    const text = "## Summary\n\n**done** — see [docs](https://example.com/x)";
    const f = fake();
    const send = createVoiceSender({ wa: f.wa, phoneNumberId: "pn-1", timeoutMs: 5000 });
    await send("573000", text, "v-1");
    expect(f.sent.map((m) => m.body)).toEqual(voiceSendChunks(text, "v-1"));
  });

  test("a long reply is sent as MULTIPLE bodies, all within the transport cap", async () => {
    const text = `long: ${"lorem ipsum dolor sit amet. ".repeat(200)}`;
    const f = fake();
    await createVoiceSender({ wa: f.wa, phoneNumberId: "pn-1", timeoutMs: 5000 })(
      "573000",
      text,
      "v-2",
    );
    expect(f.sent.length).toBeGreaterThan(1);
    for (const m of f.sent) expect(m.body.length).toBeLessThanOrEqual(CHUNK_TARGET);
  });

  test("raw markdown never reaches sendText — the conversion is not bypassable here", async () => {
    const f = fake();
    await createVoiceSender({ wa: f.wa, phoneNumberId: "pn-1", timeoutMs: 5000 })(
      "573000",
      "## Heading\n\n**bold** text",
      "v-3",
    );
    const all = f.sent.map((m) => m.body).join("\n");
    expect(all).not.toContain("**bold**");
    expect(all).not.toContain("## Heading");
  });

  test("every body goes to the recipient, and the phone number is not the warning label", async () => {
    const f = fake();
    await createVoiceSender({ wa: f.wa, phoneNumberId: "pn-1", timeoutMs: 5000 })(
      "573000",
      "hello",
      "v-4",
    );
    for (const m of f.sent) expect(m.to).toBe("573000");
    // The label is the ticket id; a recipient in a warning line was a privacy
    // regression the old path did not have.
    expect(voiceSendChunks("hello", "v-4")).toEqual(f.sent.map((m) => m.body));
  });

  test("a send that never answers is bounded, not left hanging", async () => {
    const wa = { messages: { sendText: () => new Promise<unknown>(() => {}) } };
    const send = createVoiceSender({ wa, phoneNumberId: "pn-1", timeoutMs: 30 });
    await expect(send("573000", "hi", "v-5")).rejects.toThrow(/exceeded 30ms/);
  });
});

describe("voiceSendChunks — the warning names the TICKET, never the recipient", () => {
  // A mutation reducing the label to a constant passed the entire suite, so the
  // privacy fix was unpinned. `|---|` is used because it is one of the few
  // inputs the converter leaves for the detector, so the warning actually fires.
  test("the label carries the ticket id", () => {
    const seen: string[] = [];
    voiceSendChunks("|---|", "v-abc123", (m) => seen.push(m));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("voice=v-abc123");
  });
  test("the recipient's number never appears in the warning", () => {
    const seen: string[] = [];
    const send = createVoiceSender({
      wa: { messages: { sendText: async () => ({}) } },
      phoneNumberId: "pn-1",
      timeoutMs: 5000,
      warn: (m) => seen.push(m),
    });
    return send("573017758620", "|---|", "v-abc123").then(() => {
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("voice=v-abc123");
      expect(seen[0]).not.toContain("573017758620");
    });
  });
});

describe("the raw-text fallback is unreachable from the drain (round-2 depth item)", () => {
  // Review asked whether a NON-EMPTY input can render to zero chunks and escape
  // conversion via `chunks.length ? chunks : [text]`. It can — whitespace-only
  // input does. What makes that harmless is an upstream guard, so pin BOTH.
  test("whitespace-only input is what triggers the fallback", () => {
    for (const ws of [" ", "\n", "\t", "  \n \t "]) {
      expect(renderForWhatsapp(ws, { label: "x", warn: () => {} }).chunks).toEqual([]);
      expect(voiceSendChunks(ws, "v-1")).toEqual([ws]);
    }
  });
  test("but deliverTicket trims, so send NEVER receives whitespace-only", async () => {
    const seen: string[] = [];
    const d = await deliverTicket(
      { id: "v-1", callerId: "c", deliverTo: "573000", request: "r", createdAt: "x" },
      {
        dispatch: async () => "   \n\t  ",
        send: async (_to, text) => {
          seen.push(text);
        },
        workspaceFor: () => "ws",
      },
    );
    expect(d.kind).toBe("delivered");
    expect(seen).toEqual(["(the agent finished without producing any text)"]);
    // The fallback is taken only when the RENDER is empty, so assert that
    // directly. Comparing the output to the input would not discriminate: the
    // placeholder is plain prose, so its converted form is byte-identical to it.
    expect(
      renderForWhatsapp(seen[0] as string, { label: "x", warn: () => {} }).chunks.length,
    ).toBeGreaterThan(0);
  });
});
