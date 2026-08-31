import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "./server";

// The default workspace's DISPLAY NAME is operator-configurable (BRO-1672,
// GENESIS_WORKSPACE_NAME → BuildOpts.workspaceName) so a deploy can label the root
// something meaningful ("root") instead of the "genesis" literal. The id stays
// ws-default (bindings unaffected); only the name changes.

/** Fetch the default workspace's public DTO from a freshly-built app. */
async function defaultWorkspaceName(workspaceName?: string): Promise<string | undefined> {
  const { app } = build({ workspaceRoot: tmpdir(), workspaceName });
  const res = await app.fetch(new Request("http://x/workspaces"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    workspaces: { id: string; name: string }[];
    defaultWorkspace: string;
  };
  return body.workspaces.find((w) => w.id === body.defaultWorkspace)?.name;
}

describe("default workspace name (BRO-1672)", () => {
  test("GENESIS_WORKSPACE_NAME → the default workspace's display name", async () => {
    expect(await defaultWorkspaceName("root")).toBe("root");
  });

  test("unset → falls back to the 'genesis' literal (backward compatible)", async () => {
    expect(await defaultWorkspaceName(undefined)).toBe("genesis");
  });

  test("blank / whitespace-only → falls back to 'genesis' (never an empty label)", async () => {
    expect(await defaultWorkspaceName("   ")).toBe("genesis");
  });

  test("the configured name is trimmed", async () => {
    expect(await defaultWorkspaceName("  root  ")).toBe("root");
  });

  test("the default id is always ws-default regardless of the name", async () => {
    const { app } = build({ workspaceRoot: tmpdir(), workspaceName: "root" });
    const res = await app.fetch(new Request("http://x/workspaces"));
    const body = (await res.json()) as { defaultWorkspace: string };
    expect(body.defaultWorkspace).toBe("ws-default");
  });
});

describe("GET /workspaces/browse route (BRO-1673)", () => {
  const dirs: string[] = [];
  const prevRoots = process.env.GENESIS_WORKSPACE_PATH_ROOTS;
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    if (prevRoots === undefined)
      Reflect.deleteProperty(process.env, "GENESIS_WORKSPACE_PATH_ROOTS");
    else process.env.GENESIS_WORKSPACE_PATH_ROOTS = prevRoots;
  });

  /** A tmp add-root wired via GENESIS_WORKSPACE_PATH_ROOTS (what pathAddRoots() reads). */
  function addRoot(): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "genesis-browse-route-")));
    dirs.push(d);
    process.env.GENESIS_WORKSPACE_PATH_ROOTS = d;
    return d;
  }

  test("lists subdirectories under the add-root", async () => {
    const r = addRoot();
    mkdirSync(join(r, "proj"));
    const { app } = build({ workspaceRoot: tmpdir() });
    const res = await app.fetch(
      new Request(`http://x/workspaces/browse?path=${encodeURIComponent(r)}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; entries: { name: string }[] };
    expect(body.path).toBe(r);
    expect(body.entries.map((e) => e.name)).toEqual(["proj"]);
  });

  test("a path outside the add-roots → a safe 400 (never a 500)", async () => {
    addRoot();
    const { app } = build({ workspaceRoot: tmpdir() });
    const res = await app.fetch(new Request("http://x/workspaces/browse?path=%2Fetc"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("outside the allowed roots");
  });
});

describe("voice routes (BRO-2228)", () => {
  const SECRET = "voice-secret-abc";
  const PRINCIPALS = [{ id: "573017758620", name: "Carlos" }];

  function voiceApp(over: Record<string, unknown> = {}) {
    const enqueued: unknown[] = [];
    const { app } = build({
      workspaceRoot: "/tmp",
      voiceSecret: SECRET,
      voicePrincipals: PRINCIPALS,
      enqueueVoice: (t: unknown) => {
        enqueued.push(t);
      },
      ...over,
    } as never);
    return { app, enqueued };
  }
  const post = (
    app: { fetch: (r: Request) => Promise<Response> },
    path: string,
    body: unknown,
    secret?: string,
  ) =>
    app.fetch(
      new Request(`http://x${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret ? { "x-genesis-voice-secret": secret } : {}),
        },
        body: JSON.stringify(body),
      }),
    );

  test("WITHOUT a configured secret the routes do not exist (404, not open)", async () => {
    // The failure this prevents: registering an unauthenticated intake because
    // the env var was forgotten. A 404 is loud; an open 200 is not.
    const { app } = build({ workspaceRoot: "/tmp" } as never);
    const res = await post(app as never, "/voice/identify", { callerId: "573017758620" });
    expect(res.status).toBe(404);
  });

  test("a missing or wrong secret is rejected", async () => {
    const { app } = voiceApp();
    expect((await post(app as never, "/voice/identify", {}, undefined)).status).toBe(401);
    expect((await post(app as never, "/voice/identify", {}, "wrong")).status).toBe(401);
  });

  // Raw body, not `post()`, because post() JSON.stringifies and the whole point is
  // a body that does not parse.
  const raw = (app: { fetch: (r: Request) => Promise<Response> }, path: string, body: string) =>
    app.fetch(
      new Request(`http://x${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-genesis-voice-secret": SECRET },
        body,
      }),
    );

  test("a body that does not PARSE is 400, not a cheerful 200 {known:false}", async () => {
    // asString(undefined) RETURNS "" rather than throwing, so collapsing an
    // unparseable body to `{}` gave callerId "" -> resolveCaller not-known -> the
    // same 200 a stranger gets. A truncated body or an upstream serialization bug
    // would have been indistinguishable from normal traffic, forever.
    const { app } = voiceApp();
    expect((await raw(app as never, "/voice/identify", "{not json")).status).toBe(400);
    // The sibling route had the identical pattern. Fixing one site and not the other
    // is the shape this repo keeps producing.
    expect((await raw(app as never, "/voice/request", "{not json")).status).toBe(400);
  });

  test("the voice routes BOUND the body — this is the published prefix", async () => {
    // The body cap first landed only on /walkie/answer, which the same work
    // measured as NOT published. `tailscale serve` maps /voice and nothing else,
    // so these two are the only routes an internet caller can reach at all — and
    // they still buffered without limit. Measured against a live process before
    // the fix: a 64 MB chunked POST here drove RSS +109 MB, while the guarded
    // sibling took the same body at +7 MB.
    //
    // CHUNKED, because that is the shape with no content-length, which is what
    // slips past a header check. Sent with a length it would be caught by the
    // cheap pre-filter and this test could not see the bound.
    const { app } = voiceApp();
    const chunk = new Uint8Array(64 * 1024).fill(0x7a);
    let sent = 0;
    const body = new ReadableStream({
      pull(ctrl) {
        if (sent >= 1024 * 1024) return ctrl.close();
        ctrl.enqueue(chunk);
        sent += chunk.length;
      },
    });
    for (const path of ["/voice/identify", "/voice/request"]) {
      const res = await (app as { fetch: (r: Request) => Promise<Response> }).fetch(
        new Request(`http://x${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-genesis-voice-secret": SECRET },
          body,
          duplex: "half",
        } as RequestInit),
      );
      expect(res.status).toBe(413);
      if (path === "/voice/identify") break; // one stream, one use
    }
  });

  test("a voice body that never fully arrives is 400, not an uncaught throw", async () => {
    const { app } = voiceApp();
    const failing = new ReadableStream({
      pull(ctrl) {
        ctrl.error(new Error("connection closed"));
      },
    });
    const res = await (app as { fetch: (r: Request) => Promise<Response> }).fetch(
      new Request("http://x/voice/identify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-genesis-voice-secret": SECRET },
        body: failing,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as object).toEqual({ error: "body was not fully received" });
  });

  test("POSITIVE CONTROL — a literal `null` body is VALID json and must still be 200", async () => {
    // Without this, returning 400 on anything non-object would pass the test above
    // while breaking the case the `?? {}` was originally added for.
    const { app } = voiceApp();
    const res = await raw(app as never, "/voice/identify", "null");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ known: false, canFollowUp: false });
  });

  test("identify: known caller, and unknown is a 200 not an error", async () => {
    const { app } = voiceApp();
    const known = await post(
      app as never,
      "/voice/identify",
      { callerId: "+57 301 775 8620" },
      SECRET,
    );
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual({ known: true, canFollowUp: false });

    const unknown = await post(
      app as never,
      "/voice/identify",
      { callerId: "15550001111" },
      SECRET,
    );
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ known: false, canFollowUp: false });
  });

  test("SECURITY: identify NEVER discloses the principal's name (P20 round 1)", async () => {
    // Caller id is spoofable, so anything this route returns is returned to
    // whoever guessed the number. `known` is ONE bit — set membership — which the
    // agent cannot answer without; calling it a mere echo of the caller's own
    // claim understated it, and this comment previously did. A NAME is unbounded
    // information they did not have and did not prove a right to. The original
    // response included it.
    const { app } = voiceApp();
    const res = await post(app as never, "/voice/identify", { callerId: "573017758620" }, SECRET);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ known: true, canFollowUp: false });
    expect(JSON.stringify(body)).not.toContain("Carlos");
  });

  test("request: a known caller is QUEUED, and promised nothing (no consumer exists)", async () => {
    // This test used to assert followUp:"whatsapp". It cannot any more, and that
    // is the point: with no queue-draining consumer in the tree there is no value
    // a caller of build() can pass to make this surface offer a follow-up. The
    // work is still recorded with a delivery target; only the promise is withheld.
    const { app, enqueued } = voiceApp();
    const res = await post(
      app as never,
      "/voice/request",
      { callerId: "573017758620", request: "please send me the invoice" },
      SECRET,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticketId: string; followUp: string };
    expect(body.followUp).toBe("none");
    expect(enqueued).toHaveLength(1);
    expect((enqueued[0] as { deliverTo?: string }).deliverTo).toBe("573017758620");
  });

  test("request: an unknown caller is queued but promised NOTHING", async () => {
    // The agent reads followUp aloud. Promising WhatsApp to a number we cannot
    // deliver to would be a lie told to a caller, in our voice.
    const { app, enqueued } = voiceApp();
    const res = await post(
      app as never,
      "/voice/request",
      { callerId: "15550001111", request: "hi" },
      SECRET,
    );
    const body = (await res.json()) as { followUp: string };
    expect(body.followUp).toBe("none");
    expect((enqueued[0] as { deliverTo?: string }).deliverTo).toBeUndefined();
  });

  test("identify: canFollowUp is ALWAYS false while no consumer exists", async () => {
    // Round 1 gated /voice/request and left identify unconditionally true, so
    // the two routes contradicted each other and the impossible promise came
    // back through identify — which is the answer the agent uses to decide
    // whether to OFFER a follow-up at all.
    const { app } = voiceApp();
    const res = await post(app as never, "/voice/identify", { callerId: "573017758620" }, SECRET);
    expect(await res.json()).toEqual({ known: true, canFollowUp: false });
  });

  test("identify: a non-string callerId is a 400, not a 500", async () => {
    const { app } = voiceApp();
    const res = await post(app as never, "/voice/identify", { callerId: 42 }, SECRET);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/must be text/);
  });

  test("identify: an oversized callerId is rejected", async () => {
    const { app } = voiceApp();
    const res = await post(app as never, "/voice/identify", { callerId: "9".repeat(1000) }, SECRET);
    expect(res.status).toBe(400);
  });

  test("BOTH routes agree on what a callerId may be", async () => {
    // The round-1 failure was a fix landing on one route. This asserts the two
    // in one place so a future divergence fails here rather than in production.
    const { app } = voiceApp();
    // Round 3: one non-string case would not catch max-length or null-body drift.
    const rejected: Array<{ label: string; body: unknown }> = [
      { label: "non-string", body: { callerId: 42, request: "hi" } },
      { label: "over-length", body: { callerId: "9".repeat(1000), request: "hi" } },
    ];
    for (const path of ["/voice/identify", "/voice/request"]) {
      for (const c of rejected) {
        const res = await post(app as never, path, c.body, SECRET);
        expect({ path, case: c.label, status: res.status }).toEqual({
          path,
          case: c.label,
          status: 400,
        });
      }
      // A literal `null` body is valid JSON, and round 3 measured a 500 on both
      // routes. They are NOT required to agree on the status — identify treats an
      // absent caller as a normal unknown (200), request requires a request field
      // (400) — but neither may 500, which is the invariant that was broken.
      const nullBody = await post(app as never, path, null, SECRET);
      expect({ path, status: nullBody.status }).not.toEqual({ path, status: 500 });
      expect(nullBody.status).toBeLessThan(500);
      // ...and both must ACCEPT the same human spelling of a valid number.
      const ok = await post(
        app as never,
        path,
        { callerId: "+57 301 775 8620", request: "hi" },
        SECRET,
      );
      expect({ path, status: ok.status }).toEqual({ path, status: 200 });
    }
  });

  test("request: with NO delivery leg wired, even a known caller is promised NOTHING", async () => {
    // The blocker this encodes: the surface shipped promising "whatsapp" while
    // no consumer existed anywhere to drain the queue and send. A caller heard a
    // follow-up commitment that nothing in the system could honour.
    const { app, enqueued } = voiceApp();
    const res = await post(
      app as never,
      "/voice/request",
      { callerId: "573017758620", request: "please send me the invoice" },
      SECRET,
    );
    const body = (await res.json()) as { followUp: string };
    expect(body.followUp).toBe("none");
    // Still QUEUED — the work is recorded, only the promise is withheld.
    expect(enqueued).toHaveLength(1);
  });

  test("a configured secret with NO sink fails at BUILD, not silently per call", () => {
    // enqueueVoice was optional-chained, so this combination answered 200 and
    // discarded the ticket. A misconfiguration must not be a runtime condition.
    expect(() =>
      build({ workspaceRoot: "/tmp", voiceSecret: SECRET, voicePrincipals: PRINCIPALS } as never),
    ).toThrow(/enqueueVoice/);
  });

  test("a retried tool call yields a STABLE ticket id (not yet idempotency)", async () => {
    // Named for what it proves. A fresh UUID per attempt turned one caller
    // request into N tickets; the id is now stable across retries, which is the
    // groundwork a consumer needs to collapse them. It does NOT dedupe: the second
    // record really is appended and nothing removes it until a consumer exists. An
    // earlier version asserted two records while its own comment claimed "the
    // delivery leg dedupes on id" — a component this tree does not contain.
    // (P20 Strata A, round 3.)
    const { app, enqueued } = voiceApp();
    const body = {
      callerId: "573017758620",
      request: "send the invoice",
      conversationId: "conv-77",
    };
    const a = (await (await post(app as never, "/voice/request", body, SECRET)).json()) as {
      ticketId: string;
    };
    const b = (await (await post(app as never, "/voice/request", body, SECRET)).json()) as {
      ticketId: string;
    };
    expect(a.ticketId).toBe(b.ticketId);
    expect(enqueued).toHaveLength(2); // appended twice — dedupe arrives WITH the consumer
  });

  test("a non-string field is a caller-safe 400, never a 500", async () => {
    const { app, enqueued } = voiceApp();
    const res = await post(
      app as never,
      "/voice/request",
      { callerId: "573017758620", request: 42 },
      SECRET,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/must be text/);
    expect(enqueued).toHaveLength(0);
  });

  test("an oversized conversationId is rejected, not persisted", async () => {
    const { app, enqueued } = voiceApp();
    const res = await post(
      app as never,
      "/voice/request",
      { callerId: "573017758620", request: "hi", conversationId: "x".repeat(50_000) },
      SECRET,
    );
    expect(res.status).toBe(400);
    expect(enqueued).toHaveLength(0);
  });

  test("request: an empty request is a 400 with a caller-safe message", async () => {
    const { app, enqueued } = voiceApp();
    const res = await post(
      app as never,
      "/voice/request",
      { callerId: "573017758620", request: "  " },
      SECRET,
    );
    expect(res.status).toBe(400);
    expect(enqueued).toHaveLength(0);
  });

  test("a failing sink is a 503 — never a silent success", async () => {
    // If enqueue throws and we still returned 200, the agent would tell the
    // caller their request was recorded when it was dropped.
    const { app } = voiceApp({
      enqueueVoice: () => {
        throw new Error("disk full");
      },
    });
    const res = await post(
      app as never,
      "/voice/request",
      { callerId: "573017758620", request: "x" },
      SECRET,
    );
    expect(res.status).toBe(503);
  });
});

describe("GET /admin/voice/queue — the PII endpoint's gate (BRO-2284)", () => {
  const TOKEN = "engine-token-xyz";
  function queueDir(tickets: object[], handled: object[] = []): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "genesis-vq-")));
    for (const t of tickets) appendFileSync(join(d, "queue.jsonl"), `${JSON.stringify(t)}\n`);
    for (const h of handled) appendFileSync(join(d, "delivered.jsonl"), `${JSON.stringify(h)}\n`);
    return d;
  }
  const ticket = (id: string) => ({
    id,
    callerId: "573017758620",
    deliverTo: "573017758620",
    request: `ask ${id}`,
    createdAt: "2026-08-24T00:00:00Z",
  });
  const get = (app: { fetch: (r: Request) => Promise<Response> }, path: string, headers = {}) =>
    app.fetch(new Request(`http://x${path}`, { headers }));

  test("WITHOUT an engine token the route does not exist at all (404, never open)", async () => {
    // Fails closed. The shared helper treats an unset token as "allow", which is
    // fine for a thread list and not for callers' phone numbers.
    const { app } = build({
      workspaceRoot: "/tmp",
      voiceQueueDir: queueDir([ticket("v-1")]),
    } as never);
    expect((await get(app as never, "/admin/voice/queue")).status).toBe(404);
  });

  test("with a token, no credential is 401", async () => {
    const { app } = build({
      workspaceRoot: "/tmp",
      token: TOKEN,
      voiceQueueDir: queueDir([ticket("v-1")]),
    } as never);
    expect((await get(app as never, "/admin/voice/queue")).status).toBe(401);
  });

  test("a QUERY-STRING token is REJECTED — secrets must not reach logs", async () => {
    // The shared helper accepts ?token=…; copying that here wrote a live secret
    // into access logs, proxy logs and browser history. Header only.
    const { app } = build({
      workspaceRoot: "/tmp",
      token: TOKEN,
      voiceQueueDir: queueDir([ticket("v-1")]),
    } as never);
    expect((await get(app as never, `/admin/voice/queue?token=${TOKEN}`)).status).toBe(401);
  });

  test("a wrong bearer is 401; the right one is 200", async () => {
    const { app } = build({
      workspaceRoot: "/tmp",
      token: TOKEN,
      voiceQueueDir: queueDir([ticket("v-1")]),
    } as never);
    expect(
      (await get(app as never, "/admin/voice/queue", { authorization: "Bearer nope" })).status,
    ).toBe(401);
    expect(
      (await get(app as never, "/admin/voice/queue", { authorization: `Bearer ${TOKEN}` })).status,
    ).toBe(200);
  });

  test("the response is BOUNDED, and says how many there really are", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ticket(`v-${i}`));
    const { app } = build({
      workspaceRoot: "/tmp",
      token: TOKEN,
      voiceQueueDir: queueDir(many),
    } as never);
    const body = (await (
      await get(app as never, "/admin/voice/queue", { authorization: `Bearer ${TOKEN}` })
    ).json()) as { entries: unknown[]; total: number };
    expect(body.entries).toHaveLength(50); // default
    expect(body.total).toBe(120);

    const capped = (await (
      await get(app as never, "/admin/voice/queue?limit=9999", {
        authorization: `Bearer ${TOKEN}`,
      })
    ).json()) as { entries: unknown[] };
    expect(capped.entries).toHaveLength(120); // min(limit cap 200, available)
  });

  test("an unreadable journal is reported DEGRADED, not as an empty queue", async () => {
    const d = queueDir([ticket("v-1")]);
    mkdirSync(join(d, "delivered.jsonl"), { recursive: true }); // read fails
    const { app } = build({ workspaceRoot: "/tmp", token: TOKEN, voiceQueueDir: d } as never);
    const body = (await (
      await get(app as never, "/admin/voice/queue", { authorization: `Bearer ${TOKEN}` })
    ).json()) as { degraded?: string };
    expect(body.degraded).toContain("delivered.jsonl");
    // ...and does NOT hand the caller the absolute path.
    expect(body.degraded).not.toContain(d);
  });
});
