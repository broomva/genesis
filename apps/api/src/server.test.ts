import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
      // The capability IS the consumer: there is no way to claim the channel
      // without supplying the function that sends. Tests pass a stub; production
      // passes nothing until #107 lands, which is why callers hear "none".
      voiceDelivery: { channel: "whatsapp", deliver: async () => {} },
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

  test("identify: known caller, and unknown is a 200 not an error", async () => {
    const { app } = voiceApp();
    const known = await post(
      app as never,
      "/voice/identify",
      { callerId: "+57 301 775 8620" },
      SECRET,
    );
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual({ known: true, canFollowUp: true });

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
    expect(body).toEqual({ known: true, canFollowUp: true });
    expect(JSON.stringify(body)).not.toContain("Carlos");
  });

  test("request: a known caller is queued and promised WhatsApp follow-up", async () => {
    const { app, enqueued } = voiceApp(); // voiceDelivery: "whatsapp"
    const res = await post(
      app as never,
      "/voice/request",
      { callerId: "573017758620", request: "please send me the invoice" },
      SECRET,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticketId: string; followUp: string };
    expect(body.followUp).toBe("whatsapp");
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

  test("identify: canFollowUp is FALSE when no delivery leg is wired", async () => {
    // Round 1 gated /voice/request and left identify unconditionally true, so
    // the two routes contradicted each other and the impossible promise came
    // back through identify — which is the answer the agent uses to decide
    // whether to OFFER a follow-up at all.
    const { app } = voiceApp({ voiceDelivery: undefined });
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
    const { app, enqueued } = voiceApp({ voiceDelivery: undefined });
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
