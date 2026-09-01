// The walkie surface's config gate and its two verbs (BRO-2387).
//
// DoD 3 is the one worth reading carefully: "a test asserts the routes are
// ABSENT, not merely closed". Those are different failures. A registered-but-401
// route tells an unauthenticated caller the surface exists; an unregistered one
// tells them nothing. The voice work established that distinction after shipping
// an intake surface no caller could reach while 25 tests passed against it — so
// the assertion is 404, AND a companion assertion proves 404 is not simply what
// this app returns for every unknown path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANSWER_FILE, ASK_FILE, type Ask, createAskLog } from "./ask-log";
import { build } from "./server";

const SECRET = "walkie-test-secret";
const H: Record<string, string> = { "x-genesis-walkie-secret": SECRET };

/** The house shape: build() returns { app }, requests go through app.fetch. */
type App = { fetch: (r: Request) => Promise<Response> };

const get = (app: App, path: string, headers?: Record<string, string>) =>
  app.fetch(new Request(`http://x${path}`, headers ? { headers } : undefined));

const post = (app: App, path: string, body: string, headers: Record<string, string>) =>
  app.fetch(
    new Request(`http://x${path}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body,
    }),
  );

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "walkie-routes-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ask = (over: Partial<Ask> = {}): Ask => ({
  id: "ask-1",
  sessionId: "sess-1",
  threadId: "thread-1",
  question: "Deploy to production?",
  createdAt: "2026-08-31T12:00:00.000Z",
  ...over,
});

function configured() {
  const log = createAskLog(dir);
  const { app } = build({
    workspaceRoot: dir,
    walkieSecret: SECRET,
    askLog: log,
    askLogDir: dir,
  } as never);
  return { app: app as App, log };
}

function unconfigured(): App {
  return build({ workspaceRoot: dir } as never).app as App;
}

const asksOf = async (r: Response) =>
  (
    (await r.json()) as {
      asks: { id: string; status: string; answer?: string; question?: string; threadId?: string }[];
    }
  ).asks;

describe("DoD 4 — a configured secret without a store fails at BUILD", () => {
  test("walkieSecret with no askLog throws, naming the sink", () => {
    // NOT /askLog/ — that substring also appears in the askLogDir message, so
    // disabling this throw let the OTHER one satisfy the assertion. The mutation
    // sweep caught exactly that ("build-throw for a missing sink removed"
    // SURVIVED). Match a phrase only this error carries.
    expect(() => build({ workspaceRoot: dir, walkieSecret: SECRET } as never)).toThrow(
      /askLog is not/,
    );
  });

  test("walkieSecret with a store but no directory throws too", () => {
    // The read half needs a directory. A configured surface whose GET has
    // nothing to read is the same class of half-wired as a missing sink.
    expect(() =>
      build({ workspaceRoot: dir, walkieSecret: SECRET, askLog: createAskLog(dir) } as never),
    ).toThrow(/askLogDir is not/);
  });

  test("a fully configured build does NOT throw", () => {
    // The negative control. Without it, a build() that threw unconditionally
    // would satisfy both assertions above.
    expect(() => configured()).not.toThrow();
  });
});

describe("DoD 3 — unconfigured, the routes do not exist", () => {
  test("GET /walkie/asks is 404 when no secret is configured", async () => {
    expect((await get(unconfigured(), "/walkie/asks", H)).status).toBe(404);
  });

  test("POST /walkie/answer is 404 when no secret is configured", async () => {
    const r = await post(
      unconfigured(),
      "/walkie/answer",
      JSON.stringify({ threadId: "thread-1", id: "ask-1", answer: "Yes" }),
      H,
    );
    expect(r.status).toBe(404);
  });

  test("404 means ABSENT, not 'this app 404s everything'", async () => {
    // Without this, both assertions above would pass against a build() that
    // registered nothing at all. Configured, the same path answers.
    const { app } = configured();
    expect((await get(app, "/walkie/asks", H)).status).toBe(200);
  });

  test("configured but unauthenticated is 401 — a different failure from absent", async () => {
    const { app } = configured();
    expect((await get(app, "/walkie/asks")).status).toBe(401);
    expect((await get(app, "/walkie/asks", { "x-genesis-walkie-secret": "wrong" })).status).toBe(
      401,
    );
  });
});

describe("GET /walkie/asks", () => {
  test("lists pending asks", async () => {
    const { app, log } = configured();
    log.append(ask());
    const r = await get(app, "/walkie/asks", H);
    expect(r.status).toBe(200);
    expect((await asksOf(r)).map((a) => `${a.id}:${a.status}`)).toEqual(["ask-1:pending"]);
  });

  test("an answered ask drops out unless asked for", async () => {
    const { app, log } = configured();
    log.append(ask());
    log.answer({
      threadId: "thread-1",
      id: "ask-1",
      answer: "Yes",
      answeredAt: "2026-08-31T12:05:00.000Z",
    });
    expect(await asksOf(await get(app, "/walkie/asks", H))).toEqual([]);
    expect(
      (await asksOf(await get(app, "/walkie/asks?answered=1", H))).map((a) => a.status),
    ).toEqual(["answered"]);
  });

  test("filters by thread", async () => {
    const { app, log } = configured();
    log.append(ask({ id: "a", threadId: "t1" }));
    log.append(ask({ id: "b", threadId: "t2" }));
    expect((await asksOf(await get(app, "/walkie/asks?thread=t1", H))).map((a) => a.id)).toEqual([
      "a",
    ]);
  });
});

describe("POST /walkie/answer", () => {
  test("records an answer, and the ask becomes answered", async () => {
    const { app, log } = configured();
    log.append(ask());
    const r = await post(
      app,
      "/walkie/answer",
      JSON.stringify({ threadId: "thread-1", id: "ask-1", answer: "Yes" }),
      H,
    );
    expect(r.status).toBe(200);
    const after = await asksOf(await get(app, "/walkie/asks?answered=1", H));
    expect(after[0]?.status).toBe("answered");
    expect(after[0]?.answer).toBe("Yes");
  });

  test("answering twice is a no-op, not a double effect", async () => {
    const { app, log } = configured();
    log.append(ask());
    const send = () =>
      post(
        app,
        "/walkie/answer",
        JSON.stringify({ threadId: "thread-1", id: "ask-1", answer: "Yes" }),
        H,
      );
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(await asksOf(await get(app, "/walkie/asks?answered=1", H))).toHaveLength(1);
  });

  test("an unknown id is 404, not a silent accept", async () => {
    // Otherwise a typo'd id sits in answers.jsonl forever matching nothing,
    // while the operator believes they answered.
    const { app } = configured();
    const r = await post(
      app,
      "/walkie/answer",
      JSON.stringify({ threadId: "thread-1", id: "nope", answer: "Yes" }),
      H,
    );
    expect(r.status).toBe(404);
  });

  test("unauthenticated cannot answer", async () => {
    const { app, log } = configured();
    log.append(ask());
    const r = await post(
      app,
      "/walkie/answer",
      JSON.stringify({ threadId: "thread-1", id: "ask-1", answer: "Yes" }),
      {
        "x-genesis-walkie-secret": "wrong",
      },
    );
    expect(r.status).toBe(401);
    // and nothing was recorded
    expect((await asksOf(await get(app, "/walkie/asks", H)))[0]?.status).toBe("pending");
  });

  test.each([
    ["not json", "a non-JSON body"],
    [JSON.stringify({ answer: "Yes" }), "no id"],
    [JSON.stringify({ threadId: "thread-1", id: "ask-1" }), "no answer"],
    [JSON.stringify({ threadId: "thread-1", id: "ask-1", answer: "" }), "an empty answer"],
    [JSON.stringify({ threadId: "thread-1", id: 42, answer: "Yes" }), "a non-string id"],
  ])("rejects %#: %s", async (body, _why) => {
    const { app, log } = configured();
    log.append(ask());
    expect((await post(app, "/walkie/answer", body, H)).status).toBe(400);
  });
});

describe("a read that could not look says so", () => {
  test("an unreadable ask log surfaces `degraded`, not an empty list", async () => {
    // The failure this prevents: a permissions problem or a bad mount reads as
    // "nothing is waiting on you", which is the most dangerous possible lie for
    // this surface. Uncovered until the mutation sweep found "degraded flag
    // swallowed" surviving.
    const { app, log } = configured();
    log.append(ask());
    // Make asks.jsonl unreadable — EACCES rather than ENOENT, which is the only
    // healthy absence.
    const { chmodSync } = await import("node:fs");
    chmodSync(join(dir, "asks.jsonl"), 0o000);
    const r = await get(app, "/walkie/asks", H);
    const body = (await r.json()) as { asks: unknown[]; degraded?: string };
    chmodSync(join(dir, "asks.jsonl"), 0o644);
    expect(body.degraded).toBeDefined();
    expect(body.degraded).toContain("asks.jsonl");
    // and it names the FILE, never the absolute path — this reaches a browser
    expect(body.degraded).not.toContain(dir);
  });
});

describe("the two stores stay separate", () => {
  test("answering never writes into the voice intake queue", async () => {
    const { app, log } = configured();
    log.append(ask());
    await post(
      app,
      "/walkie/answer",
      JSON.stringify({ threadId: "thread-1", id: "ask-1", answer: "Yes" }),
      H,
    );
    expect(existsSync(join(dir, "queue.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "asks.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "answers.jsonl"))).toBe(true);
  });
});

describe("findings from the P20 review", () => {
  test("GET /walkie/asks is bounded, and says when it truncated", async () => {
    // 100k asks returned a 16.2 MB body; the sibling /admin/voice/queue capped
    // at 200 over the same record count.
    const { app, log } = configured();
    for (let i = 0; i < 120; i++) log.append(ask({ id: `a-${i}` }));
    const body = (await (await get(app, "/walkie/asks", H)).json()) as {
      asks: unknown[];
      total: number;
      truncated?: boolean;
    };
    expect(body.asks).toHaveLength(50);
    expect(body.total).toBe(120);
    expect(body.truncated).toBe(true);
  });

  test("limit is honoured and capped", async () => {
    const { app, log } = configured();
    for (let i = 0; i < 300; i++) log.append(ask({ id: `a-${i}` }));
    expect(
      ((await (await get(app, "/walkie/asks?limit=10", H)).json()) as { asks: unknown[] }).asks,
    ).toHaveLength(10);
    // Above the cap, the cap wins.
    expect(
      ((await (await get(app, "/walkie/asks?limit=99999", H)).json()) as { asks: unknown[] }).asks,
    ).toHaveLength(200);
  });

  test("an oversized answer is refused, not appended", async () => {
    const { app, log } = configured();
    log.append(ask());
    const huge = "x".repeat(5000);
    const r = await post(
      app,
      "/walkie/answer",
      JSON.stringify({ threadId: "thread-1", id: "ask-1", answer: huge }),
      H,
    );
    expect(r.status).toBe(413);
    // and it stayed pending
    expect((await asksOf(await get(app, "/walkie/asks", H)))[0]?.status).toBe("pending");
  });

  test("an unreadable log is a 503, never 'no such ask'", async () => {
    // Dropping `degraded` here made an unreadable asks.jsonl collapse to an
    // empty list, so answering a REAL pending ask returned 404 "no such ask" —
    // telling the operator their question does not exist.
    const { app, log } = configured();
    log.append(ask());
    const { chmodSync } = await import("node:fs");
    chmodSync(join(dir, "asks.jsonl"), 0o000);
    const r = await post(
      app,
      "/walkie/answer",
      JSON.stringify({ threadId: "thread-1", id: "ask-1", answer: "Yes" }),
      H,
    );
    chmodSync(join(dir, "asks.jsonl"), 0o644);
    expect(r.status).toBe(503);
    expect(r.status).not.toBe(404);
  });
});

describe("the body is bounded before it is parsed", () => {
  test("a declared oversize Content-Length is 413 without parsing", async () => {
    // c.req.json() buffers the WHOLE body before any check, and this server has
    // no body-size limit anywhere (`app.use` appears zero times), so an
    // authenticated caller could spend RSS on a request that was going to 400.
    const { app } = configured();
    const r = await app.fetch(
      new Request("http://x/walkie/answer", {
        method: "POST",
        headers: { ...H, "content-type": "application/json", "content-length": "999999" },
        body: JSON.stringify({ threadId: "thread-1", id: "ask-1", answer: "Yes" }),
      }),
    );
    expect(r.status).toBe(413);
    expect((await r.json()) as { error: string }).toEqual({ error: "body too large" });
  });

  test("a normal request is unaffected by the guard", async () => {
    // The negative control: a guard that rejected everything would satisfy the
    // assertion above.
    const { app, log } = configured();
    log.append(ask());
    expect(
      (
        await post(
          app,
          "/walkie/answer",
          JSON.stringify({ threadId: "thread-1", id: "ask-1", answer: "Yes" }),
          H,
        )
      ).status,
    ).toBe(200);
  });
});

// The regression a live server found and 1689 unit tests did not: widening what
// `degraded` covers made POST refuse on a malformed RECORD, not just an
// unreadable FILE — so one bad line in an append-only journal blocked answering
// every other ask, permanently. (BRO-2387, P11.)
describe("a malformed record must not block answering a good ask", () => {
  test("POST succeeds while the log reports malformed records", async () => {
    const { app, log } = configured();
    log.append(ask({ id: "good" }));
    // One line no typed writer could produce — which is why no fixture in this
    // file had ever produced it. It states a thread, so it is SERVED and counted
    // as incomplete; a record with no thread is skipped instead, which is a
    // different message and a different test.
    appendFileSync(
      join(dir, ASK_FILE),
      `${JSON.stringify({ threadId: "t", id: "bad", question: "Q?" })}\n`,
    );

    const body = (await (await get(app, "/walkie/asks", H)).json()) as { degraded?: string };
    // The disclosure still happens...
    expect(body.degraded).toContain("missing sessionId or createdAt");

    // ...and the answer still lands. 503 here is the regression.
    const res = await post(
      app,
      "/walkie/answer",
      JSON.stringify({ threadId: "thread-1", id: "good", answer: "yes" }),
      H,
    );
    expect(res.status).toBe(200);
  });

  test("an unreadable answers.jsonl also refuses — status quo, now pinned", async () => {
    // Before this change POST refused on `degraded`, which EITHER journal could
    // set. Narrowing `unreadable` to asks.jsonl would be a behaviour change
    // smuggled in under a malformed-record fix, so it is not narrowed — and this
    // test is why that is a decision rather than an accident. An answers.jsonl
    // that cannot be read makes every answered ask render as pending: a
    // plausible-looking backlog, which is the worse of the two read failures.
    const { app, log } = configured();
    log.append(ask({ id: "good" }));
    log.answer({
      threadId: "thread-1",
      id: "other",
      answer: "x",
      answeredAt: "2026-08-31T12:00:00.000Z",
    });
    // WRITE-ONLY (0o222), not 0o000. With no write bit the append itself throws
    // and the route 503s from its catch, so the assertion passes without the
    // read check ever mattering — the mutation sweep caught exactly that: the
    // first version of this test SURVIVED the mutant it was written to kill.
    chmodSync(join(dir, ANSWER_FILE), 0o222);
    const res = await post(
      app,
      "/walkie/answer",
      JSON.stringify({ threadId: "thread-1", id: "good", answer: "yes" }),
      H,
    );
    chmodSync(join(dir, ANSWER_FILE), 0o644);
    expect(res.status).toBe(503);
  });

  test("POST still refuses when a FILE cannot be read", async () => {
    // The negative control. Without it the fix above could have deleted the
    // refusal outright and the test above would still pass.
    const { app, log } = configured();
    log.append(ask({ id: "good" }));
    chmodSync(join(dir, ASK_FILE), 0o000);
    const res = await post(
      app,
      "/walkie/answer",
      JSON.stringify({ threadId: "thread-1", id: "good", answer: "yes" }),
      H,
    );
    chmodSync(join(dir, ASK_FILE), 0o644);
    expect(res.status).toBe(503);
  });
});

// Four defects CodeRabbit flagged as "merge risk: high" on a PR whose own checks
// were green. Each was then MEASURED against a live server before being fixed —
// the claims arrived as prose with no line citations, so the probe is what turned
// them into findings. (BRO-2387, P11.)
describe("the four merge-risk findings", () => {
  const streamOf = (bytes: number) => {
    const chunk = new Uint8Array(64 * 1024).fill(0x7a); // 'z'
    let sent = 0;
    return new ReadableStream({
      pull(ctrl) {
        if (sent >= bytes) return ctrl.close();
        const n = Math.min(chunk.length, bytes - sent);
        ctrl.enqueue(chunk.subarray(0, n));
        sent += n;
      },
    });
  };

  test("a CHUNKED oversized body is refused without being buffered", async () => {
    // The measured defect: a 64MB chunked body took the server's RSS from 124MB
    // to 245MB. A chunked request sends no content-length, so the header guard
    // never fired and only the post-parse length cap rejected it — by which
    // point the bytes were already resident.
    const { app } = configured();
    const req = new Request("http://x/walkie/answer", {
      method: "POST",
      headers: { ...H, "content-type": "application/json" },
      body: streamOf(1024 * 1024),
      // `duplex` is required whenever the body is a stream. Bun's lib types it,
      // so no ts-expect-error here — tsc rejects an unused one, which is how the
      // gate caught that this suppression had stopped suppressing anything.
      duplex: "half",
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(413);
    expect((await res.json()) as { error: string }).toEqual({ error: "body too large" });
  });

  test("a body at EXACTLY the cap is not refused", async () => {
    // The negative control — and it has to actually reach the boundary. The
    // first version of this test was named for the cap and sent 123 bytes
    // against 65536, so flipping `total > max` to `total >= max` left this whole
    // file green; only a unit test in another file, against a different
    // constant, could see it. A test named for a boundary it never approaches is
    // worse than no test, because the name is what the next reader trusts.
    //
    // 65536 bytes exactly, built by measuring the envelope rather than guessing
    // it: an off-by-one in the padding silently moves this off the boundary in
    // the safe direction, which is exactly how it stops discriminating.
    const { app, log } = configured();
    log.append(ask({ id: "a1" }));
    const envelope = JSON.stringify({ threadId: "thread-1", id: "a1", answer: "" }).length;
    const answer = "y".repeat(64 * 1024 - envelope);
    const body = JSON.stringify({ threadId: "thread-1", id: "a1", answer });
    expect(new TextEncoder().encode(body).byteLength).toBe(64 * 1024);
    const res = await post(app, "/walkie/answer", body, H);
    // 413 for the ANSWER cap (4096 chars) is the right answer here — what must
    // not happen is the BODY cap rejecting it, which would be "body too large".
    expect((await res.json()) as { error?: string }).not.toEqual({ error: "body too large" });
  });

  test("one byte over the cap IS refused — by readBounded, not the header", async () => {
    // CHUNKED, deliberately. Sent with a content-length, cap+1 is caught by the
    // cheap `declared > MAX_BODY_BYTES` pre-filter and readBounded is never
    // reached, so the test would pass with the bound deleted — a fixture the
    // mutant cannot reach. A chunked request carries no content-length, which is
    // the whole reason the bound exists, so this is the only shape that puts the
    // boundary itself under test.
    const { app, log } = configured();
    log.append(ask({ id: "a1" }));
    const res = await app.fetch(
      new Request("http://x/walkie/answer", {
        method: "POST",
        headers: { ...H, "content-type": "application/json" },
        body: streamOf(64 * 1024 + 1),
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect((await res.json()) as object).toEqual({ error: "body too large" });
  });

  test("one byte UNDER the cap, chunked, reaches the parser", async () => {
    // The other side of the same boundary, through the same path. Without it,
    // `total > max` could become `total >= 0` and the test above still passes.
    const { app } = configured();
    const res = await app.fetch(
      new Request("http://x/walkie/answer", {
        method: "POST",
        headers: { ...H, "content-type": "application/json" },
        body: streamOf(64 * 1024 - 1),
        duplex: "half",
      } as RequestInit),
    );
    // 'zzz…' is not JSON, so reaching the parser is exactly what 400 proves.
    expect(res.status).toBe(400);
    expect((await res.json()) as object).toEqual({ error: "body must be JSON" });
  });

  test("responses carry Cache-Control: no-store", async () => {
    const { app } = configured();
    const g = await get(app, "/walkie/asks", H);
    expect(g.headers.get("cache-control")).toBe("no-store");
    const p = await post(
      app,
      "/walkie/answer",
      JSON.stringify({ threadId: "thread-1", id: "x", answer: "y" }),
      H,
    );
    expect(p.headers.get("cache-control")).toBe("no-store");
  });

  test("a DIFFERENT second answer is a 409 that names the decision that stands", async () => {
    // Measured: POST SHIP then POST HOLD, and the live route served HOLD. The
    // DoD says "acking twice is a no-op"; last-write-wins is not that.
    //
    // The first fix returned 200 {recorded:true, alreadyAnswered:true} here, and
    // that was its own defect: `recorded` then meant "your answer was recorded"
    // on one branch and "an answer exists" on the other, so a client doing the
    // natural `if (body.recorded)` renders "recorded" for a decision that was
    // discarded. A repeat is not a replacement, and the response now says so.
    const { app, log } = configured();
    log.append(ask({ id: "a1" }));
    expect(
      (
        await post(
          app,
          "/walkie/answer",
          JSON.stringify({ threadId: "thread-1", id: "a1", answer: "SHIP" }),
          H,
        )
      ).status,
    ).toBe(200);
    const second = await post(
      app,
      "/walkie/answer",
      JSON.stringify({ threadId: "thread-1", id: "a1", answer: "HOLD" }),
      H,
    );
    expect(second.status).toBe(409);
    // It NAMES the standing decision, so a client can show it instead of guessing.
    expect((await second.json()) as object).toEqual({
      error: "already answered",
      recorded: false,
      answer: "SHIP",
    });
    const [e] = await asksOf(await get(app, "/walkie/asks?answered=1", H));
    expect(e?.answer).toBe("SHIP");
  });

  test("an IDENTICAL second answer is a genuine 200 no-op", async () => {
    // The other half, and the reason the 409 above is not merely "reject
    // repeats": a retry whose first attempt the client never saw succeed must
    // not look like a conflict. Same text, same outcome, 200.
    const { app, log } = configured();
    log.append(ask({ id: "a1" }));
    await post(
      app,
      "/walkie/answer",
      JSON.stringify({ threadId: "thread-1", id: "a1", answer: "SHIP" }),
      H,
    );
    const again = await post(
      app,
      "/walkie/answer",
      JSON.stringify({ threadId: "thread-1", id: "a1", answer: "SHIP" }),
      H,
    );
    expect(again.status).toBe(200);
    expect((await again.json()) as object).toEqual({ recorded: true, alreadyAnswered: true });
  });
  test("the repeat does not append a second line to answers.jsonl", async () => {
    const { app, log } = configured();
    log.append(ask({ id: "a1" }));
    await post(
      app,
      "/walkie/answer",
      JSON.stringify({ threadId: "thread-1", id: "a1", answer: "SHIP" }),
      H,
    );
    await post(
      app,
      "/walkie/answer",
      JSON.stringify({ threadId: "thread-1", id: "a1", answer: "SHIP" }),
      H,
    );
    const lines = readFileSync(join(dir, ANSWER_FILE), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  test("a NON-colliding id still gets its answer — the negative control", async () => {
    // Without this the ambiguity check could withhold every answer and all of
    // the above would still pass.
    const { app, log } = configured();
    log.append(ask({ id: "solo" }));
    log.answer({
      threadId: "thread-1",
      id: "solo",
      answer: "KEPT",
      answeredAt: "2026-08-31T12:00:00.000Z",
    });
    const [e] = await asksOf(await get(app, "/walkie/asks?answered=1", H));
    expect(e?.answer).toBe("KEPT");
  });

  test("a body that never fully arrives is 400 'not fully received', not 500", async () => {
    // readBounded REJECTS when the stream errors, and awaiting it outside a try
    // let that escape the handler: over a real socket a malformed chunk-size
    // line, an RST mid-body and a clean FIN mid-body each produced an uncaught
    // AbortException, 32 lines of stderr, and a 500. It also must not be folded
    // into the JSON-parse catch — this file says why three hundred lines up:
    // "a transport fault would have looked like a stranger".
    const { app } = configured();
    const failing = new ReadableStream({
      pull(ctrl) {
        ctrl.error(new Error("connection closed"));
      },
    });
    const res = await app.fetch(
      new Request("http://x/walkie/answer", {
        method: "POST",
        headers: { ...H, "content-type": "application/json" },
        body: failing,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as object).toEqual({ error: "body was not fully received" });
  });

  test("an EMPTY answer is not a decision and does not lock the ask", async () => {
    // POST already refuses one with "answer must be a non-empty string", so a
    // reader accepting it let the two halves disagree about what a decision is:
    // the ask read back as ANSWERED, vanished from the pending list, and every
    // later attempt got a 409 naming an empty standing decision.
    const { app, log } = configured();
    log.append(ask({ id: "a1" }));
    appendFileSync(
      join(dir, ANSWER_FILE),
      `${JSON.stringify({ threadId: "thread-1", id: "a1", answer: "", answeredAt: "2026-08-31T12:00:00.000Z" })}\n`,
    );
    const [e] = await asksOf(await get(app, "/walkie/asks", H));
    expect(e?.status).toBe("pending");
    expect(
      (
        await post(
          app,
          "/walkie/answer",
          JSON.stringify({ threadId: "thread-1", id: "a1", answer: "SHIP" }),
          H,
        )
      ).status,
    ).toBe(200);
  });

  test("`?thread=` (present, empty) narrows rather than silently widening", async () => {
    // `c.req.query("thread")` returns "" for `?thread=`, and treating that as
    // absent widened the read to EVERY thread — the opposite of what the caller
    // asked, on the one parameter whose job is narrowing.
    const { app, log } = configured();
    log.append(ask({ id: "named", threadId: "t1" }));
    const body = await (await get(app, "/walkie/asks?thread=", H)).text();
    expect(body).not.toContain("named");
  });

  test("concurrent conflicting answers: exactly one wins, and it is the first", async () => {
    // CodeRabbit returned "merge risk: HIGH" on the claim that concurrent
    // conflicting answers can overwrite the decision that should win. Measured
    // rather than argued: they cannot, in-process. The read-check-write span in
    // POST /walkie/answer contains no `await`, so JS's single thread makes it
    // atomic — and this test is what keeps that true, because inserting one
    // `await` anywhere in that span silently reintroduces the race.
    const { app, log } = configured();
    log.append(ask({ id: "a1" }));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post(
          app,
          "/walkie/answer",
          JSON.stringify({ threadId: "thread-1", id: "a1", answer: `ANSWER-${i}` }),
          H,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);

    // ONE line on disk, not twenty. The status codes alone would pass if every
    // request appended and only the responses differed.
    const lines = readFileSync(join(dir, ANSWER_FILE), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);

    // And it is the FIRST answer that stands, not the last.
    const [e] = await asksOf(await get(app, "/walkie/asks?answered=1", H));
    expect(e?.answer).toBe("ANSWER-0");
  });

  describe("paging past the hard cap", () => {
    /** 250 asks — beyond the 200 cap — with the interesting one LAST, since the
     *  page is oldest-first and the newest fall off the end. */
    const overCap = (log: ReturnType<typeof createAskLog>) => {
      for (let i = 0; i < 250; i++) {
        log.append(
          ask({
            id: `a${i}`,
            question: `Q${i}`,
            createdAt: `2026-08-31T12:00:${String(i % 60).padStart(2, "0")}.000Z`,
          }),
        );
      }
    };

    test("without an offset the tail is UNREACHABLE by any request", async () => {
      // The measurement that motivated this: `?limit=1000` is clamped to the 200
      // hard cap, so before `offset` existed the newest 50 could not be retrieved
      // at all — on an append-only journal, so the set only grows.
      const { app, log } = configured();
      overCap(log);
      const { asks, total } = (await (await get(app, "/walkie/asks?limit=1000", H)).json()) as {
        asks: { id: string }[];
        total: number;
      };
      expect(total).toBe(250);
      expect(asks).toHaveLength(200);
      expect(asks.some((a) => a.id === "a249")).toBe(false);
    });

    test("with an offset it is reachable", async () => {
      const { app, log } = configured();
      overCap(log);
      const { asks } = (await (await get(app, "/walkie/asks?limit=200&offset=200", H)).json()) as {
        asks: { id: string }[];
      };
      expect(asks).toHaveLength(50);
      expect(asks.some((a) => a.id === "a249")).toBe(true);
    });

    test("`truncated` means 'more after THIS page', so a paging client terminates", async () => {
      // `entries.length > page.length` stayed true on the final page, so a client
      // paging until `truncated` disappeared would never stop.
      const { app, log } = configured();
      overCap(log);
      const last = (await (await get(app, "/walkie/asks?limit=200&offset=200", H)).json()) as {
        truncated?: boolean;
      };
      expect(last.truncated).toBeUndefined();
      const first = (await (await get(app, "/walkie/asks?limit=200", H)).json()) as {
        truncated?: boolean;
      };
      expect(first.truncated).toBe(true);
    });

    test("THE THREAT MODEL, restated past the cap: GET still reaches what the 409 names", async () => {
      // The 409 on POST /walkie/answer names the standing decision, and the only
      // reason that is not a disclosure is that the same credential can already
      // read it with GET. Past the cap it could NOT, so the 409 was the sole
      // channel for exactly the asks a client could not otherwise see — a bound
      // added for response size silently invalidating a security argument made
      // elsewhere. This is the assertion that keeps the two in step.
      const { app, log } = configured();
      overCap(log);
      log.answer({
        threadId: "thread-1",
        id: "a249",
        answer: "BEYOND-THE-CAP",
        answeredAt: "2026-08-31T13:00:00.000Z",
      });
      const viaGet = await (
        await get(app, "/walkie/asks?answered=1&limit=200&offset=200", H)
      ).text();
      expect(viaGet).toContain("BEYOND-THE-CAP");
      const via409 = await post(
        app,
        "/walkie/answer",
        JSON.stringify({ threadId: "thread-1", id: "a249", answer: "x" }),
        H,
      );
      expect(via409.status).toBe(409);
      expect(await via409.text()).toContain("BEYOND-THE-CAP");
    });

    test("an offset past the end is an empty page, not an error", async () => {
      const { app, log } = configured();
      log.append(ask({ id: "only" }));
      const res = await get(app, "/walkie/asks?offset=9999", H);
      expect(res.status).toBe(200);
      expect((await res.json()) as { asks: unknown[] }).toMatchObject({ asks: [], total: 1 });
    });
  });
});

describe("an ask is (threadId, id) — the key that replaced the ambiguity machinery", () => {
  /** Two asks sharing an id in different threads. Under the old id-only key this
   *  was the hazard the election existed to detect; now it is just two asks. */
  const collide = () => {
    appendFileSync(
      join(dir, ASK_FILE),
      `${JSON.stringify({ id: "dup", sessionId: "s", threadId: "t-a", question: "Wire $40,000 to vendor X?", createdAt: "2026-08-31T12:00:00.000Z" })}\n` +
        `${JSON.stringify({ id: "dup", sessionId: "s", threadId: "t-b", question: "Approve the staging rebuild?", createdAt: "2026-08-31T12:00:00.000Z" })}\n`,
    );
  };

  test("BOTH are served — the old key made one of them vanish", async () => {
    const { app } = configured();
    collide();
    const asks = await asksOf(await get(app, "/walkie/asks", H));
    expect(asks).toHaveLength(2);
    expect(asks.map((a) => a.threadId).sort()).toEqual(["t-a", "t-b"]);
  });

  test("each is answerable independently, and neither answer reaches the other", async () => {
    // THE DEFECT THAT TOOK FOUR ROUNDS, now impossible rather than detected. The
    // election used to withhold BOTH answers and 409 both writes; before that it
    // joined one thread's decision to the other's question — the $40,000 wire.
    const { app } = configured();
    collide();
    expect(
      (
        await post(
          app,
          "/walkie/answer",
          JSON.stringify({ threadId: "t-a", id: "dup", answer: "WIRE-APPROVED" }),
          H,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          app,
          "/walkie/answer",
          JSON.stringify({ threadId: "t-b", id: "dup", answer: "REBUILD-OK" }),
          H,
        )
      ).status,
    ).toBe(200);

    const a = await asksOf(await get(app, "/walkie/asks?thread=t-a&answered=1", H));
    const b = await asksOf(await get(app, "/walkie/asks?thread=t-b&answered=1", H));
    expect(a[0]?.question).toBe("Wire $40,000 to vendor X?");
    expect(a[0]?.answer).toBe("WIRE-APPROVED");
    expect(b[0]?.question).toBe("Approve the staging rebuild?");
    expect(b[0]?.answer).toBe("REBUILD-OK");
  });

  test("an answer written for one thread does not surface on the other", async () => {
    // The read-side half, asserted separately: the join key, not the write path,
    // is what keeps them apart.
    const { app, log } = configured();
    collide();
    log.answer({
      threadId: "t-a",
      id: "dup",
      answer: "ALICE-ONLY",
      answeredAt: "2026-08-31T12:01:00.000Z",
    });
    const b = await (await get(app, "/walkie/asks?thread=t-b&answered=1", H)).text();
    expect(b).not.toContain("ALICE-ONLY");
    const a = await (await get(app, "/walkie/asks?thread=t-a&answered=1", H)).text();
    expect(a).toContain("ALICE-ONLY");
  });

  test("answering with the WRONG thread is 404, not a join to someone else's ask", async () => {
    const { app, log } = configured();
    log.append(ask({ id: "only", threadId: "t-a" }));
    const res = await post(
      app,
      "/walkie/answer",
      JSON.stringify({ threadId: "t-b", id: "only", answer: "x" }),
      H,
    );
    expect(res.status).toBe(404);
  });

  test("answering without a threadId is 400", async () => {
    const { app, log } = configured();
    log.append(ask({ id: "only" }));
    const res = await post(app, "/walkie/answer", JSON.stringify({ id: "only", answer: "x" }), H);
    expect(res.status).toBe(400);
    expect((await res.json()) as object).toEqual({ error: "threadId must be a non-empty string" });
  });

  test("the 409 can no longer name another thread's decision", async () => {
    // Strictly better than the behaviour it replaces. The old 409 returned the
    // standing answer for a bare id, so a caller who knew an id learned a
    // decision from a thread they never named — defensible only because a plain
    // GET exposed it too. Scoped to (threadId, id), the question does not arise.
    const { app, log } = configured();
    collide();
    log.answer({
      threadId: "t-a",
      id: "dup",
      answer: "ALICE-PRIVATE",
      answeredAt: "2026-08-31T12:01:00.000Z",
    });
    const res = await post(
      app,
      "/walkie/answer",
      JSON.stringify({ threadId: "t-b", id: "dup", answer: "x" }),
      H,
    );
    expect(res.status).toBe(200); // t-b's ask is unanswered; this is its answer
    expect(await (await get(app, "/walkie/asks?thread=t-b&answered=1", H)).text()).not.toContain(
      "ALICE-PRIVATE",
    );
  });

  test("BLOCKER kept: a thread-less row is still skipped, so it absorbs nothing", async () => {
    // The $40,000 reproduction. The gate that skips a row stating no thread stays
    // — the composite key removes the ELECTION, not the attribution rule.
    const { app, log } = configured();
    log.append(ask({ id: "tc-9", threadId: "t-alice", question: "Wire $40,000 to vendor X?" }));
    appendFileSync(
      join(dir, ASK_FILE),
      `${JSON.stringify({ id: "tc-9", question: "Approve the staging rebuild?" })}\n`,
    );
    expect(await (await get(app, "/walkie/asks", H)).text()).not.toContain("staging rebuild");
    expect(
      (
        await post(
          app,
          "/walkie/answer",
          JSON.stringify({ threadId: "t-alice", id: "tc-9", answer: "APPROVED" }),
          H,
        )
      ).status,
    ).toBe(200);
    const [e] = await asksOf(await get(app, "/walkie/asks?thread=t-alice&answered=1", H));
    expect(e?.question).toBe("Wire $40,000 to vendor X?");
  });

  test("a row naming a thread but NO question is skipped, not served", async () => {
    // The question gate's own input, restored. It was covered by a test the
    // rekey deleted along with the ambiguity block, which left its mutant with
    // no killer — a coverage cut hidden inside a refactor. The gate is still
    // load-bearing: this row states a thread, so the attribution gate lets it
    // through, and only the missing question keeps it out.
    const { app, log } = configured();
    log.append(ask({ id: "real", threadId: "t-a", question: "The real question?" }));
    appendFileSync(join(dir, ASK_FILE), `${JSON.stringify({ id: "junk", threadId: "t-a" })}\n`);
    const asks = await asksOf(await get(app, "/walkie/asks?thread=t-a", H));
    expect(asks).toHaveLength(1);
    expect(asks[0]?.id).toBe("real");
    const body = await (await get(app, "/walkie/asks?thread=t-a", H)).text();
    expect(body).toContain("skipped");
  });
});

describe("Genesis serves the client, so both share one origin (BRO-2416)", () => {
  const withClient = () => {
    const clientDir = join(dir, "client");
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(join(clientDir, "index.html"), "<!doctype html><title>walkie</title>");
    writeFileSync(join(clientDir, "app.js"), "console.log('walkie')");
    const log = createAskLog(dir);
    const { app } = build({
      workspaceRoot: dir,
      walkieSecret: SECRET,
      askLog: log,
      askLogDir: dir,
      walkieClientDir: clientDir,
    } as never);
    return { app: app as App, clientDir, log };
  };

  test("the shell is served WITHOUT the secret — it carries no credential", async () => {
    // Gating it would mean putting the secret in a URL to fetch the page that
    // asks for it. The client reads its secret from localStorage precisely so
    // the bundle can be served without one.
    const { app } = withClient();
    const res = await get(app, "/walkie/app/index.html");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("walkie");
  });

  test("the directory path serves index.html", async () => {
    const { app } = withClient();
    expect((await get(app, "/walkie/app/")).status).toBe(200);
  });

  test("app.js is served with a JavaScript content type", async () => {
    // A browser refuses to execute a module served as text/plain, so the type is
    // load-bearing rather than cosmetic.
    const { app } = withClient();
    expect((await get(app, "/walkie/app/app.js")).headers.get("content-type")).toContain(
      "text/javascript",
    );
  });

  test("TRAVERSAL out of the client directory is refused", async () => {
    // The ask journal lives in `dir`; the client lives in `dir/client`. This is
    // the request that would read the operator's pending decisions off disk
    // through a route that serves static files.
    const { app, log } = withClient();
    log.append(ask({ question: "SECRET-QUESTION" }));
    const res = await get(app, "/walkie/app/../asks.jsonl");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("SECRET-QUESTION");
  });

  test("a directory that is not a built client is refused at BUILD", async () => {
    // CodeRabbit's caveat, made mechanical: "the configured directory must
    // contain only public client assets". The realistic failure is an operator
    // pointing this at the wrong tree — a home directory, a docs folder — where
    // the extension allowlist would then serve any .html/.json/.png under it.
    // Failing at boot is the same rule the sibling misconfigurations follow.
    const empty = join(dir, "not-a-client");
    mkdirSync(empty, { recursive: true });
    expect(() =>
      build({
        workspaceRoot: dir,
        walkieSecret: SECRET,
        askLog: createAskLog(dir),
        askLogDir: dir,
        walkieClientDir: empty,
      } as never),
    ).toThrow(/does not look like a built walkie client/);
  });

  test("a directory with index.html but NO app.js is refused too", async () => {
    // Both files, not either: a lone index.html is what a docs directory looks
    // like, and checking one of the two would let exactly that through.
    const half = join(dir, "half-a-client");
    mkdirSync(half, { recursive: true });
    writeFileSync(join(half, "index.html"), "<!doctype html>");
    expect(() =>
      build({
        workspaceRoot: dir,
        walkieSecret: SECRET,
        askLog: createAskLog(dir),
        askLogDir: dir,
        walkieClientDir: half,
      } as never),
    ).toThrow(/does not look like a built walkie client/);
  });

  test("an unconfigured deploy has NO such route — the negative control", async () => {
    // Same rule as every other walkie option: unconfigured must 404 rather than
    // answer. Without this the route could be registered unconditionally and
    // every test above would still pass.
    const { app } = configured(); // no walkieClientDir
    const res = await get(app, "/walkie/app/index.html");
    expect(res.status).toBe(404);
    // THE BODY, not just the status. Registering the route with an undefined
    // directory also 404s — resolveAsset fails closed — so status alone cannot
    // tell "no such route" from "route present, nothing to serve", and the
    // mutant that registers it unconditionally SURVIVED a status-only check.
    // Hono's own 404 says "404 Not Found"; this route's handler says "not found".
    expect(await res.text()).not.toBe("not found");
  });
});
