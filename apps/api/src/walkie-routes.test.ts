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
import { InMemoryStore } from "@genesis/core";
import { ANSWER_FILE, ASK_FILE, type Ask, createAskLog } from "./ask-log";
import { build } from "./server";

const SECRET = "walkie-test-secret";
const H: Record<string, string> = { "x-genesis-walkie-secret": SECRET };
// Walkie now REFUSES to build without an owner token (BRO-2417): `unauthorized()`
// fails open without one, so the walkie secret would gate nothing.
const OWNER_TOKEN = "owner-token";

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
    token: OWNER_TOKEN,
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
      token: OWNER_TOKEN,
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
        token: OWNER_TOKEN,
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
        token: OWNER_TOKEN,
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

describe("an ask whose session moved on is stale, not pending (BRO-2415)", () => {
  /** A store carrying exactly the session phases a test cares about. */
  const storeWith = (sessions: { threadId: string; phase: string }[]) =>
    ({
      listSessions: async () => sessions.map((s, i) => ({ ...s, id: `s${i}`, workspaceId: "w" })),
    }) as never;

  const withStore = (sessions: { threadId: string; phase: string }[]) => {
    const log = createAskLog(dir);
    const { app } = build({
      workspaceRoot: dir,
      walkieSecret: SECRET,
      askLog: log,
      askLogDir: dir,
      token: OWNER_TOKEN,
      store: storeWith(sessions),
    } as never);
    return { app: app as App, log };
  };

  test("a session that finished retires its ask", async () => {
    // The whole point: nothing ever ended an ask except an answer, so a turn
    // that simply completed left its question waiting on a person forever.
    const { app, log } = withStore([{ threadId: "t1", phase: "done" }]);
    log.append(ask({ id: "a1", threadId: "t1" }));
    expect(await asksOf(await get(app, "/walkie/asks", H))).toHaveLength(0);
  });

  test("a session still AWAITING keeps its ask — the negative control", async () => {
    // Without this, markStale could retire everything and the test above passes.
    const { app, log } = withStore([{ threadId: "t1", phase: "awaiting" }]);
    log.append(ask({ id: "a1", threadId: "t1" }));
    expect(await asksOf(await get(app, "/walkie/asks", H))).toHaveLength(1);
  });

  test("a crashed session — reconciled to `blocked` at boot — retires its ask", async () => {
    // The case a third journal could never have covered: the edge OUT of
    // `awaiting` is exactly what a dead process never observes.
    // reconcileInterruptedSessions already turns that into `blocked`, so deriving
    // from phase gets the restart right for free.
    const { app, log } = withStore([{ threadId: "t1", phase: "blocked" }]);
    log.append(ask({ id: "a1", threadId: "t1" }));
    expect(await asksOf(await get(app, "/walkie/asks", H))).toHaveLength(0);
  });

  test("an UNKNOWN thread is left alone — absence is not evidence", async () => {
    // The producer can append before the session is persisted. Retiring an ask
    // because we have never heard of its thread would hide a live question, and
    // this whole file refuses to read absence as an answer.
    const { app, log } = withStore([]);
    log.append(ask({ id: "a1", threadId: "t-unknown" }));
    expect(await asksOf(await get(app, "/walkie/asks", H))).toHaveLength(1);
  });

  test("a stale ask is still visible under ?answered=1, marked", async () => {
    // Retired, not deleted: a question that was asked and abandoned stays
    // auditable.
    const { app, log } = withStore([{ threadId: "t1", phase: "done" }]);
    log.append(ask({ id: "a1", threadId: "t1" }));
    const all = await asksOf(await get(app, "/walkie/asks?answered=1", H));
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("stale");
  });

  test("an ANSWERED ask is never relabelled stale", async () => {
    // The decision is the record. Its session finishing is normal — that is what
    // happens right after an answer unblocks the agent — so aging must not reach
    // an ask that already has one. Without this the guard `status !== "pending"`
    // could be deleted and every other test here still passes: they all start
    // from a pending ask.
    const { app, log } = withStore([{ threadId: "t1", phase: "done" }]);
    log.append(ask({ id: "a1", threadId: "t1" }));
    log.answer({
      threadId: "t1",
      id: "a1",
      answer: "SHIP",
      answeredAt: "2026-09-01T12:00:00.000Z",
    });
    const [e] = await asksOf(await get(app, "/walkie/asks?answered=1", H));
    expect(e?.status).toBe("answered");
    expect(e?.answer).toBe("SHIP");
  });

  test("`total` counts what is SHOWN, not what is on disk", async () => {
    // The client renders "N waiting" from this. Counting retired asks would put
    // the dead ones back in the number they were removed from the list for.
    const { app, log } = withStore([
      { threadId: "t-live", phase: "awaiting" },
      { threadId: "t-done", phase: "done" },
    ]);
    log.append(ask({ id: "a1", threadId: "t-live" }));
    log.append(ask({ id: "a2", threadId: "t-done" }));
    const body = (await (await get(app, "/walkie/asks", H)).json()) as { total: number };
    expect(body.total).toBe(1);
  });

  test("a store that throws ages NOTHING rather than retiring everything", async () => {
    // Fail-open on purpose: hiding a real question is worse than showing a dead
    // one, and a read that could not look must not present as a clean list.
    const log = createAskLog(dir);
    const { app } = build({
      workspaceRoot: dir,
      walkieSecret: SECRET,
      askLog: log,
      askLogDir: dir,
      token: OWNER_TOKEN,
      store: {
        listSessions: async () => {
          throw new Error("store on fire");
        },
      },
    } as never);
    log.append(ask({ id: "a1", threadId: "t1" }));
    const res = await get(app as App, "/walkie/asks", H);
    expect(await asksOf(res)).toHaveLength(1);
    // ...AND SAYS SO. Keeping the ask is right; keeping it silently is the
    // failure this file's degraded channel exists to prevent — a clean-looking
    // list whose lifecycle status is actually unknown.
    const body = (await (await get(app as App, "/walkie/asks", H)).json()) as { degraded?: string };
    expect(body.degraded).toContain("sessions could not be read");
  });

  test("a journal problem AND a session problem both travel", async () => {
    // Joined, not overwritten — the same rule readAsks applies to its own
    // problems. A caller must not have to guess which read failed.
    const log = createAskLog(dir);
    const { app } = build({
      workspaceRoot: dir,
      walkieSecret: SECRET,
      askLog: log,
      askLogDir: dir,
      token: OWNER_TOKEN,
      store: {
        listSessions: async () => {
          throw new Error("store on fire");
        },
      },
    } as never);
    log.append(ask({ id: "a1", threadId: "t1" }));
    appendFileSync(join(dir, ASK_FILE), `${JSON.stringify({ id: "junk" })}\n`);
    const body = (await (await get(app as App, "/walkie/asks", H)).json()) as { degraded?: string };
    expect(body.degraded).toContain("skipped");
    expect(body.degraded).toContain("sessions could not be read");
  });
});

describe("read mirrors: the client's own gate, and only OWNER-reads (BRO-2417)", () => {
  const TOKEN = "owner-token";

  // All FIVE mirrors, with a REGISTERED workspace id. The first cut of this block
  // enumerated two of five in every structural test; three independent P20 strata
  // each proved the same thing by mutation — deleting the three git mirrors, or
  // stripping `walkieDenied` from them, left the whole 198-test suite green. A
  // test named for "the mirrors" that iterates 40% of them is a coverage claim
  // that is simply false, so the list is hoisted and every test iterates IT.
  const WS = "ws-default"; // auto-registered from `workspaceRoot`
  const MIRRORS = [
    "/walkie/threads",
    "/walkie/workspaces",
    `/walkie/workspaces/${WS}/git/status`,
    `/walkie/workspaces/${WS}/git/diff`,
    `/walkie/workspaces/${WS}/checks`,
  ] as const;
  const TWIN = (m: string) => m.replace("/walkie", "");

  const both = () => {
    const log = createAskLog(dir);
    const store = new InMemoryStore();
    store.upsertSession({
      id: "sess-1",
      workspaceId: WS,
      threadId: "thread-1",
      phase: "awaiting",
      createdAt: "2026-08-31T12:00:00.000Z",
      title: "Wire $40,000 — approve?",
    });
    const { app } = build({
      workspaceRoot: dir,
      walkieSecret: SECRET,
      askLog: log,
      askLogDir: dir,
      token: TOKEN,
      store,
    } as never);
    return app as App;
  };
  const owner = (app: App, path: string) => get(app, path, { authorization: `Bearer ${TOKEN}` });

  /** A store holding `n` sessions, counting the per-session turn reads so a test
   *  can assert the WORK is bounded and not merely the response. */
  const seeded = (n: number) => {
    const store = new InMemoryStore();
    for (let i = 0; i < n; i++) {
      store.upsertSession({
        id: `sess-${i}`,
        workspaceId: WS,
        threadId: `thread-${i}`,
        phase: "idle",
        // STRICTLY descending, so `thread-0` really is newest and page order is
        // checkable. The first version was `31 - (i % 28)`, which wraps every 28
        // — thread-56 was the newest and thread-0 ranked 9th of 250 — so the
        // comment was false and no test could assert ordering against it.
        createdAt: new Date(Date.UTC(2026, 7, 31, 12, 0, 0) - i * 1000).toISOString(),
      });
    }
    let turnReads = 0;
    const original = store.turnsForSession.bind(store);
    (store as unknown as { turnsForSession: (id: string) => unknown }).turnsForSession = (
      id: string,
    ) => {
      turnReads++;
      return original(id);
    };
    // Counted too: on the pg store `listSessions` is a full `SELECT *` that
    // hydrates every row, so how many times a request does it is the cost the
    // turn-read count does not show.
    let sessionScans = 0;
    const origList = store.listSessions.bind(store);
    (store as unknown as { listSessions: () => unknown }).listSessions = () => {
      sessionScans++;
      return origList();
    };
    // And the bounded read that replaced it (follow-up to BRO-2418). Counting BOTH is what
    // makes "one scan, not two" checkable as the stronger "no scan at all":
    // a regression that reverted to listSessions-plus-slice would still make
    // exactly one bounded-looking request, so counting pages alone cannot see it.
    let pageQueries = 0;
    const origPage = store.sessionsPage.bind(store);
    (store as unknown as { sessionsPage: (o: unknown) => unknown }).sessionsPage = (o: unknown) => {
      pageQueries++;
      return origPage(o as { limit?: number; offset?: number });
    };
    return {
      store,
      reads: () => turnReads,
      scans: () => sessionScans,
      pages: () => pageQueries,
    };
  };

  const pagedApp = (store: unknown) =>
    build({
      workspaceRoot: dir,
      walkieSecret: SECRET,
      askLog: createAskLog(dir),
      askLogDir: dir,
      token: TOKEN,
      store,
    } as never).app as App;

  test("the 200 cap TRUNCATES — not merely parses (BRO-2418)", async () => {
    // The DoD's distinction: a route can accept `?limit=` and honour nothing. So
    // this seeds MORE than the cap and asserts on the row count returned.
    const { store } = seeded(250);
    const app = pagedApp(store);
    const r = (await (await get(app, "/walkie/threads?limit=1000", H)).json()) as {
      threads: unknown[];
      total: number;
      hasMore: boolean;
    };
    expect(r.threads.length).toBe(200);
    expect(r.total).toBe(250);
    expect(r.hasMore).toBe(true);
  });

  test("pages are ordered newest-first and do not overlap", async () => {
    // The sort moved above the slice, so ordering and page disjointness are now
    // properties of the SAME operation — and neither was asserted.
    const { store } = seeded(250);
    const app = pagedApp(store);
    const page = async (q: string) =>
      (
        (await (await get(app, `/walkie/threads?${q}`, H)).json()) as {
          threads: Array<{ threadId: string }>;
        }
      ).threads.map((t) => t.threadId);
    expect(await page("limit=3")).toEqual(["thread-0", "thread-1", "thread-2"]);
    expect(await page("limit=3&offset=3")).toEqual(["thread-3", "thread-4", "thread-5"]);
  });

  test("equal timestamps do not make pages overlap or drop rows", async () => {
    // Ties decide whether a page boundary is stable. `Array#sort` is stable in
    // both the old and new orders, but nothing asserted it — and the previous
    // fixture had 250 distinct timestamps, so the case was unreachable.
    const store = new InMemoryStore();
    for (let i = 0; i < 10; i++) {
      store.upsertSession({
        id: `s-${i}`,
        workspaceId: WS,
        threadId: `tie-${i}`,
        phase: "idle",
        createdAt: "2026-08-31T12:00:00.000Z", // all identical
      });
    }
    const app = pagedApp(store);
    const ids = async (q: string) =>
      (
        (await (await get(app, `/walkie/threads?${q}`, H)).json()) as {
          threads: Array<{ threadId: string }>;
        }
      ).threads.map((t) => t.threadId);
    const first = await ids("limit=5");
    const second = await ids("limit=5&offset=5");
    expect(first.length).toBe(5);
    expect(second.length).toBe(5);
    expect(first.filter((x) => second.includes(x))).toEqual([]); // disjoint
    expect(new Set([...first, ...second]).size).toBe(10); // and complete

    // ORDER, because disjointness and completeness follow from slice arithmetic
    // for ANY deterministic comparator — the two checks above hold even if ties
    // are ordered arbitrarily. What ties decide is stability, and stability is
    // only visible as order: equal timestamps must keep the store's order.
    //
    // A review flagged that mutating the comparator's tie branch `0` -> `1`
    // survives this. It does, and the precise reason matters — an earlier draft
    // of this comment said "non-zero", which would tell a future reviewer to
    // dismiss a live mutant as equivalent.
    //
    // The invisible class is NON-NEGATIVE, not non-zero. Sorting here merges by
    // asking only `cmp(right, left) < 0`, so any tie value >= 0 takes the same
    // branch as 0 and the output is byte-identical: measured over 514
    // configurations (all-equal at n = 2..1000, mixed runs, randomised tie
    // patterns), zero differed. That is an EQUIVALENT mutant through
    // `Array.prototype.sort` — no test can kill it because it changes nothing.
    //
    // `0` -> `-1` is a DIFFERENT story and is killable: it reverses every tie
    // run at every n. The assertion below is what catches it, and is also what
    // kills the committed `listThreads stops ordering newest-first` mutant.
    expect([...first, ...second]).toEqual([
      "tie-0",
      "tie-1",
      "tie-2",
      "tie-3",
      "tie-4",
      "tie-5",
      "tie-6",
      "tie-7",
      "tie-8",
      "tie-9",
    ]);
  });

  test("the DEFAULT is 200, not 50 — the constant the design argument rests on", async () => {
    // Nothing enforced this: the source comment and the PR body both spend a
    // paragraph on "200, NOT 50, and the difference is deliberate", and mutating
    // the default to 50 left every test green. A defended constant with no
    // assertion is a preference, not a decision.
    const { store } = seeded(250);
    const app = pagedApp(store);
    const r = (await (await get(app, "/walkie/threads", H)).json()) as { threads: unknown[] };
    expect(r.threads.length).toBe(200);
  });

  test("hasMore is FALSE past the end, not just at it", async () => {
    // `offset + threads.length !== total` passes every earlier case and is a live
    // bug here: at offset beyond total it reports hasMore forever, so a client
    // paging until false never stops.
    const { store } = seeded(250);
    const app = pagedApp(store);
    const r = (await (await get(app, "/walkie/threads?offset=300", H)).json()) as {
      threads: unknown[];
      hasMore: boolean;
    };
    expect(r.threads.length).toBe(0);
    expect(r.hasMore).toBe(false);
  });

  test("offset reaches the tail the cap would otherwise strand", async () => {
    // A cap without an offset does not page the tail, it makes it UNREACHABLE —
    // the lesson `/walkie/asks` records, applied here before it could bite.
    const { store } = seeded(250);
    const app = pagedApp(store);
    const r = (await (await get(app, "/walkie/threads?offset=200", H)).json()) as {
      threads: unknown[];
      hasMore: boolean;
    };
    expect(r.threads.length).toBe(50);
    // FALSE on the final page — computed from where this page ends, not from
    // whether it happens to be full.
    expect(r.hasMore).toBe(false);
  });

  test("hasMore is FALSE on a final page that happens to be exactly full", async () => {
    // The case the naive form gets wrong: `threads.length === limit` is true on
    // a full last page, so a client paging until hasMore is false loops forever
    // — or, believing there is more, shows a control that returns nothing. Found
    // by mutation: the earlier tests all had a short or an over-cap final page,
    // so both formulas agreed and the assertion proved nothing.
    const { store } = seeded(250);
    const app = pagedApp(store);
    const r = (await (await get(app, "/walkie/threads?limit=50&offset=200", H)).json()) as {
      threads: unknown[];
      hasMore: boolean;
    };
    expect(r.threads.length).toBe(50); // exactly full
    expect(r.hasMore).toBe(false); // and yet the last
  });

  test("a limit bounds the WORK, not just the response (BRO-2418)", async () => {
    // The point of paging at the source. Slicing the result would have produced
    // an identical response while still reading every turn of every session, so
    // this counts the reads rather than trusting the row count.
    const { store, reads } = seeded(250);
    const app = pagedApp(store);
    const r = (await (await get(app, "/walkie/threads?limit=10", H)).json()) as {
      threads: unknown[];
    };
    expect(r.threads.length).toBe(10);
    expect(reads()).toBe(10);
  });

  test("a request makes ONE sessionsPage call and never calls listSessions", async () => {
    // The first version paired listThreads with a separate countThreads and each
    // scanned independently — a paging change that removed the per-session turn
    // reads and doubled the scan underneath them, on a polled surface. That was
    // fixed to one scan; this now asserts ZERO, because the page and the total
    // both come from `sessionsPage`, which bounds the retrieval in SQL.
    //
    // NAMED for what it observes. It was called "...and NO full scan", which
    // `scans()` cannot see: that counter increments on `listSessions` only and is
    // structurally blind to the `count(*)` the request still issues. The request
    // does perform a full scan, for the total.
    //
    // Both assertions, and NEITHER is redundant — though the first version of
    // this comment claimed `scans() === 0` was the load-bearing one "because the
    // page count cannot distinguish a revert". That was wrong: `pages()` counts
    // `sessionsPage` specifically, so a supervisor-level revert to
    // `listSessions()`-then-slice makes it 0 and fails on its own.
    //
    // What `scans() === 0` actually adds is the narrower case the page count
    // cannot see: a `sessionsPage` that is itself implemented over
    // `listSessions()`. That returns a byte-identical response through exactly
    // one `sessionsPage` call, and only the absence of the unbounded read
    // distinguishes it.
    const { store, scans, pages } = seeded(250);
    const app = pagedApp(store);
    await get(app, "/walkie/threads?limit=10", H);
    expect(pages()).toBe(1);
    expect(scans()).toBe(0);
  });

  test("the mirror and its twin page IDENTICALLY", async () => {
    // Paging one side and not the other is exactly the drift the shared body
    // exists to prevent, and it would not show on an unpaged request.
    const { store } = seeded(250);
    const app = pagedApp(store);
    for (const q of ["?limit=7", "?limit=7&offset=13", "?limit=1000", ""]) {
      const a = await (await get(app, `/walkie/threads${q}`, H)).text();
      const b = await (await owner(app, `/threads${q}`)).text();
      expect(`${q}:${a}`).toBe(`${q}:${b}`);
    }
  });

  test("every mirror returns exactly what its OWNER-GATED twin returns", async () => {
    // Asserted against the twin, not a fixture: two copies of a response shape
    // are two truths, and the one nobody looks at is the one that rots. All five
    // pairs — the earlier two-pair loop let three copy-pasted git handlers sit
    // under a comment claiming every mirror shared a body function.
    const app = both();
    for (const m of MIRRORS) {
      const a = await (await get(app, m, H)).text();
      const b = await (await owner(app, TWIN(m))).text();
      expect(`${m}:${a}`).toBe(`${m}:${b}`);
    }
  });

  test("the compared payloads are NOT EMPTY — the equality above is not vacuous", async () => {
    // The guard that caught this block's first defect, now pinned to DATA rather
    // than to schema. Its first version checked the workspaces payload for the
    // literal "defaultWorkspace" — a KEY the body always emits, so it could not
    // detect the emptiness it existed to detect. Two strata found that
    // independently. Both sentinels below are values the fixture seeds.
    const app = both();
    const threads = (await (await get(app, "/walkie/threads", H)).json()) as {
      threads: Array<{ threadId: string }>;
    };
    expect(threads.threads.length).toBeGreaterThan(0);
    expect(threads.threads[0]?.threadId).toBe("thread-1");
    const ws = (await (await get(app, "/walkie/workspaces", H)).json()) as {
      workspaces: Array<{ id: string }>;
    };
    expect(ws.workspaces.length).toBeGreaterThan(0);
    expect(ws.workspaces.map((w) => w.id)).toContain(WS);
  });

  test("NO MIRROR PAYLOAD carries the workspace rootPath", async () => {
    // `server.ts` claims this and, until P20 round 3, nothing checked it: the
    // dogfood grepped for a path built from an env var the entrypoint does not
    // read, so the needle was never present and the grep was a guaranteed pass.
    // A shell check alone also dies with the shell — this pins it in the suite.
    const app = both();
    for (const m of MIRRORS) {
      const body = await (await get(app, m, H)).text();
      expect(`${m} leaks dir:${body.includes(dir)}`).toBe(`${m} leaks dir:false`);
      // The property, not one platform's spelling.
      expect(`${m} absolute path:${/"\/(Users|home|root|opt|private|var)\//.test(body)}`).toBe(
        `${m} absolute path:false`,
      );
    }
  });

  test("EVERY mirror is no-store — a phone must not cache a working-tree diff", async () => {
    // `noStore(c)` is the first line of all five, and nothing asserted it: P20
    // round 2 dropped it from a mirror and 202 tests stayed green. The existing
    // cache assertion covers /walkie/asks and /walkie/answer only, and the
    // rationale applies MORE strongly here — these carry diff bodies, thread
    // titles and last agent turns, not ask ids.
    const app = both();
    for (const m of MIRRORS) {
      const res = await get(app, m, H);
      expect(`${m}:${res.headers.get("cache-control")}`).toBe(`${m}:no-store`);
    }
  });

  test("the walkie secret opens EVERY mirror", async () => {
    // The positive control. Without it "404 on an unknown workspace" was the only
    // assertion touching the git mirrors, and Hono 404s any unregistered path —
    // so deleting the routes outright was indistinguishable from a pass.
    const app = both();
    for (const m of MIRRORS) {
      const res = await get(app, m, H);
      // diff without ?path is a 400 by contract (its twin does the same); what
      // matters here is that the route EXISTS and the gate let us through.
      expect(`${m}:${res.status !== 401 && res.status !== 404}`).toBe(`${m}:true`);
    }
  });

  test("EVERY mirror is 401 with no credential, and with a WRONG secret", async () => {
    // The gate, per mirror. Mutation-proven necessary: stripping `walkieDenied`
    // from a single git mirror previously left 198/198 green while turning a
    // working-tree diff read into an unauthenticated one.
    const app = both();
    for (const m of MIRRORS) {
      expect(`${m} bare:${(await get(app, m)).status}`).toBe(`${m} bare:401`);
      const wrong = await get(app, m, { "x-genesis-walkie-secret": "not-the-secret" });
      expect(`${m} wrong:${wrong.status}`).toBe(`${m} wrong:401`);
    }
  });

  test("the OWNER TOKEN opens no mirror, and the walkie secret opens no twin", async () => {
    // Neither credential is a superset of the other, so a leak of one is not a
    // leak of the other's surface.
    const app = both();
    for (const m of MIRRORS) {
      expect(`${m}:${(await owner(app, m)).status}`).toBe(`${m}:401`);
      expect(`${TWIN(m)}:${(await get(app, TWIN(m), H)).status}`).toBe(`${TWIN(m)}:401`);
    }
  });

  test("READ-ONLY BY CONSTRUCTION: the only non-GET verb under /walkie is the answer", async () => {
    // The PR's central security argument, asserted over the ROUTE TABLE instead
    // of in prose. The previous negative control probed three OWNER-gated writes,
    // which never consult `walkieDenied` at all — a stratum proved it stays green
    // with a walkie-gated `POST /walkie/workspaces/:id/git/commit` registered and
    // answering 200. This assertion is what makes the sentence true: a write verb
    // added to the namespace fails HERE, at the claim, not somewhere downstream.
    const app = both() as unknown as {
      routes: Array<{ path: string; method: string }>;
    };
    const writes = [
      ...new Set(
        app.routes
          .filter((r) => r.path.startsWith("/walkie") && r.method !== "GET")
          .map((r) => `${r.method} ${r.path}`),
      ),
    ].sort();
    expect(writes).toEqual(["POST /walkie/answer"]);
  });

  test("the walkie secret unlocks no OWNER write — every registered one, DERIVED", async () => {
    // DERIVED from the route table, not hand-listed. The first version listed
    // three verbs against nine registered, omitting POST /message and
    // POST /api/chat — which DISPATCH AN AGENT TURN, i.e. arbitrary command
    // execution in a workspace, a strictly larger blast radius than the git
    // commit the comment named as its worst case. A hand list also goes stale the
    // day someone adds the tenth verb, which is exactly when it matters.
    //
    // Deriving also removes a vacuity: a route that is NOT registered in this
    // fixture answers 404, and a 404 would satisfy a "not 200" assertion while
    // proving nothing about the gate. Only routes actually in the table are
    // probed, so every 401 here is a gate rejecting a real request.
    const app = both();
    const table = (app as unknown as { routes: Array<{ path: string; method: string }> }).routes;
    const writes = [
      ...new Set(
        table
          .filter((r) => r.method !== "GET" && r.method !== "ALL")
          .map((r) => `${r.method} ${r.path}`),
      ),
    ]
      .sort()
      .filter((r) => !r.includes(" /walkie/")); // the answer verb is walkie's own

    // The derivation must not silently collapse to nothing.
    expect(writes.length).toBeGreaterThanOrEqual(8);

    for (const entry of writes) {
      const [method, template] = entry.split(" ");
      if (!method || !template) throw new Error(`unparsable route entry: ${entry}`);
      const path = template.replace(/:\w+/g, WS);
      const res = await app.fetch(
        new Request(`http://x${path}`, {
          method,
          headers: { ...H, "content-type": "application/json" },
          body: JSON.stringify({ message: "nope", text: "nope", threadId: "thread-1" }),
        }),
      );
      expect(`${method} ${path}:${res.status}`).toBe(`${method} ${path}:401`);
    }
  });

  test("no mirror accepts its credential from the QUERY STRING, under any param name", async () => {
    // `unauthorized()` reads `c.req.query("token")`, which is half the reason the
    // client cannot use it. The realistic defect is that fallback being copied
    // into `walkieDenied` — so `token` is the load-bearing name here. The first
    // version tested only `?secret=`, a string that appears NOWHERE in this
    // codebase, and a mutant adding the real `c.req.query("token")` fallback
    // sailed through it.
    const app = both();
    for (const m of MIRRORS) {
      for (const q of ["token", "secret", "walkieSecret", "x-genesis-walkie-secret"]) {
        const res = await get(app, `${m}${m.includes("?") ? "&" : "?"}${q}=${SECRET}`);
        expect(`${m}?${q}:${res.status}`).toBe(`${m}?${q}:401`);
      }
    }
  });

  test("EVERY mirror is ABSENT (not merely closed) when walkie is unconfigured", async () => {
    const app = build({ workspaceRoot: dir, token: TOKEN } as never).app as App;
    for (const m of MIRRORS) {
      expect(`${m}:${(await get(app, m, H)).status}`).toBe(`${m}:404`);
    }
    // The companion the file's header demands: 404 must mean ABSENT, not "this
    // app 404s everything". A route that IS registered on the same build answers.
    expect((await get(app, "/health")).status).toBe(200);
  });

  test("an unknown workspace is 404 WITH THE BODY, not Hono's default 404", async () => {
    // Status alone cannot distinguish "route present, workspace unknown" from
    // "route absent" — Hono returns 404 for any unregistered path. The body can:
    // ours is JSON, Hono's default is the literal text "404 Not Found". This is
    // the same discriminator the /walkie/app route already uses, for the same
    // reason (a status-only check there let a mutant survive).
    const app = both();
    for (const p of [
      "/walkie/workspaces/nope/git/status",
      "/walkie/workspaces/nope/git/diff",
      "/walkie/workspaces/nope/checks",
    ]) {
      const res = await get(app, p, H);
      expect(`${p}:${res.status}`).toBe(`${p}:404`);
      expect(`${p}:${await res.text()}`).toBe(`${p}:{"error":"unknown workspace"}`);
    }
  });

  test("walkieSecret without a token throws at BUILD, naming the fail-open helper", () => {
    // `unauthorized()` opens with `if (!opts.token) return false`, so on a
    // tokenless deploy every owner verb is already open and the walkie secret
    // gates nothing. A surface whose gate gates nothing should not boot.
    //
    // (An earlier draft added a "before the mirrors this was self-correcting"
    // rationale here. It was false — /walkie/asks and /walkie/answer are
    // header-gated, so the loop already ran tokenless — and it was retracted in
    // server.ts while surviving verbatim HERE for a full review round. Deleting
    // a claim at one of its two sites is not deleting it.)
    expect(() =>
      build({
        workspaceRoot: dir,
        walkieSecret: SECRET,
        askLog: createAskLog(dir),
        askLogDir: dir,
      } as never),
    ).toThrow(/walkieSecret is set but token is not/);
  });
});
