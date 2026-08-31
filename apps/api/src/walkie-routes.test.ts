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
import { appendFileSync, chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
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
  ((await r.json()) as { asks: { id: string; status: string; answer?: string }[] }).asks;

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
      JSON.stringify({ id: "ask-1", answer: "Yes" }),
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
    log.answer({ id: "ask-1", answer: "Yes", answeredAt: "2026-08-31T12:05:00.000Z" });
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
    const r = await post(app, "/walkie/answer", JSON.stringify({ id: "ask-1", answer: "Yes" }), H);
    expect(r.status).toBe(200);
    const after = await asksOf(await get(app, "/walkie/asks?answered=1", H));
    expect(after[0]?.status).toBe("answered");
    expect(after[0]?.answer).toBe("Yes");
  });

  test("answering twice is a no-op, not a double effect", async () => {
    const { app, log } = configured();
    log.append(ask());
    const send = () =>
      post(app, "/walkie/answer", JSON.stringify({ id: "ask-1", answer: "Yes" }), H);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(await asksOf(await get(app, "/walkie/asks?answered=1", H))).toHaveLength(1);
  });

  test("an unknown id is 404, not a silent accept", async () => {
    // Otherwise a typo'd id sits in answers.jsonl forever matching nothing,
    // while the operator believes they answered.
    const { app } = configured();
    const r = await post(app, "/walkie/answer", JSON.stringify({ id: "nope", answer: "Yes" }), H);
    expect(r.status).toBe(404);
  });

  test("unauthenticated cannot answer", async () => {
    const { app, log } = configured();
    log.append(ask());
    const r = await post(app, "/walkie/answer", JSON.stringify({ id: "ask-1", answer: "Yes" }), {
      "x-genesis-walkie-secret": "wrong",
    });
    expect(r.status).toBe(401);
    // and nothing was recorded
    expect((await asksOf(await get(app, "/walkie/asks", H)))[0]?.status).toBe("pending");
  });

  test.each([
    ["not json", "a non-JSON body"],
    [JSON.stringify({ answer: "Yes" }), "no id"],
    [JSON.stringify({ id: "ask-1" }), "no answer"],
    [JSON.stringify({ id: "ask-1", answer: "" }), "an empty answer"],
    [JSON.stringify({ id: 42, answer: "Yes" }), "a non-string id"],
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
    await post(app, "/walkie/answer", JSON.stringify({ id: "ask-1", answer: "Yes" }), H);
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
    const r = await post(app, "/walkie/answer", JSON.stringify({ id: "ask-1", answer: huge }), H);
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
    const r = await post(app, "/walkie/answer", JSON.stringify({ id: "ask-1", answer: "Yes" }), H);
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
        body: JSON.stringify({ id: "ask-1", answer: "Yes" }),
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
      (await post(app, "/walkie/answer", JSON.stringify({ id: "ask-1", answer: "Yes" }), H)).status,
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
    // file had ever produced it.
    appendFileSync(join(dir, ASK_FILE), `${JSON.stringify({ id: "bad", question: "Q?" })}\n`);

    const body = (await (await get(app, "/walkie/asks", H)).json()) as { degraded?: string };
    // The disclosure still happens...
    expect(body.degraded).toContain("missing sessionId or createdAt");

    // ...and the answer still lands. 503 here is the regression.
    const res = await post(app, "/walkie/answer", JSON.stringify({ id: "good", answer: "yes" }), H);
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
    log.answer({ id: "other", answer: "x", answeredAt: "2026-08-31T12:00:00.000Z" });
    // WRITE-ONLY (0o222), not 0o000. With no write bit the append itself throws
    // and the route 503s from its catch, so the assertion passes without the
    // read check ever mattering — the mutation sweep caught exactly that: the
    // first version of this test SURVIVED the mutant it was written to kill.
    chmodSync(join(dir, ANSWER_FILE), 0o222);
    const res = await post(app, "/walkie/answer", JSON.stringify({ id: "good", answer: "yes" }), H);
    chmodSync(join(dir, ANSWER_FILE), 0o644);
    expect(res.status).toBe(503);
  });

  test("POST still refuses when a FILE cannot be read", async () => {
    // The negative control. Without it the fix above could have deleted the
    // refusal outright and the test above would still pass.
    const { app, log } = configured();
    log.append(ask({ id: "good" }));
    chmodSync(join(dir, ASK_FILE), 0o000);
    const res = await post(app, "/walkie/answer", JSON.stringify({ id: "good", answer: "yes" }), H);
    chmodSync(join(dir, ASK_FILE), 0o644);
    expect(res.status).toBe(503);
  });
});
