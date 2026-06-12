import { describe, expect, test } from "bun:test";
import {
  type PostableThread,
  handleControlCommand,
  nativeCommandMenu,
  parseCommand,
} from "./handler";

function mockThread(id = "telegram:1"): PostableThread & { posts: string[] } {
  const posts: string[] = [];
  return {
    id,
    posts,
    async post(content: string | AsyncIterable<string>) {
      if (typeof content === "string") posts.push(content);
      return undefined;
    },
  };
}

/** A fetch stub that records /control calls and returns a scripted body. */
function controlFetch(body: unknown): { fetch: typeof fetch; calls: Array<{ action: string }> } {
  const calls: Array<{ action: string }> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as { action: string };
    calls.push({ action: parsed.action });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("parseCommand", () => {
  test("parses token + args, strips @botname", () => {
    expect(parseCommand("/new")).toEqual({ token: "new", args: "" });
    expect(parseCommand("/model opus 4.5")).toEqual({ token: "model", args: "opus 4.5" });
    expect(parseCommand("/status@Broomvatechbot")).toEqual({ token: "status", args: "" });
    expect(parseCommand("  /help  ")).toEqual({ token: "help", args: "" });
  });
  test("non-commands return undefined", () => {
    expect(parseCommand("hello")).toBeUndefined();
    expect(parseCommand("/tmp/foo is a path")).toBeUndefined(); // contains a slash mid-token
    expect(parseCommand("3/4")).toBeUndefined();
  });
});

describe("handleControlCommand", () => {
  test("/help and /commands reply locally without hitting /control", async () => {
    const t = mockThread();
    const { fetch, calls } = controlFetch({ ok: true });
    expect(await handleControlCommand(t, "/help", { baseUrl: "x", fetchImpl: fetch })).toBe(true);
    expect(
      await handleControlCommand(t, "/commands", {
        baseUrl: "x",
        fetchImpl: fetch,
        skillsDirs: ["/no/dir"],
      }),
    ).toBe(true);
    expect(calls.length).toBe(0); // purely local
    expect(t.posts[0]).toContain("/new");
    expect(t.posts[1]).toContain("commands");
  });

  test("/new → reset action; reply reflects ok", async () => {
    const t = mockThread();
    const { fetch, calls } = controlFetch({ ok: true });
    expect(await handleControlCommand(t, "/new", { baseUrl: "x", fetchImpl: fetch })).toBe(true);
    expect(calls).toEqual([{ action: "reset" }]);
    expect(t.posts[0]).toContain("Fresh conversation");
  });

  test("/stop → interrupt; /status → status", async () => {
    const t = mockThread();
    const { fetch, calls } = controlFetch({ ok: true, alive: true, phase: "running" });
    await handleControlCommand(t, "/stop", { baseUrl: "x", fetchImpl: fetch });
    await handleControlCommand(t, "/status", { baseUrl: "x", fetchImpl: fetch });
    expect(calls.map((c) => c.action)).toEqual(["interrupt", "status"]);
    expect(t.posts[0]).toContain("Interrupted");
    expect(t.posts[1]).toContain("live");
  });

  test("a skill command is NOT a control command (returns false → forwarded)", async () => {
    const t = mockThread();
    const { fetch, calls } = controlFetch({ ok: true });
    expect(
      await handleControlCommand(t, "/autonomous go", { baseUrl: "x", fetchImpl: fetch }),
    ).toBe(false);
    expect(await handleControlCommand(t, "/model opus", { baseUrl: "x", fetchImpl: fetch })).toBe(
      false,
    );
    expect(await handleControlCommand(t, "plain text", { baseUrl: "x", fetchImpl: fetch })).toBe(
      false,
    );
    expect(calls.length).toBe(0);
    expect(t.posts.length).toBe(0);
  });

  test("not-ok control results give a friendly fallback reply", async () => {
    const t = mockThread();
    const { fetch } = controlFetch({ ok: false, reason: "no-session" });
    await handleControlCommand(t, "/new", { baseUrl: "x", fetchImpl: fetch });
    await handleControlCommand(t, "/stop", { baseUrl: "x", fetchImpl: fetch });
    expect(t.posts[0]).toContain("Nothing to reset");
    expect(t.posts[1]).toContain("Nothing is running");
  });
});

describe("nativeCommandMenu", () => {
  test("is a valid setMyCommands payload (<=100, name+description)", () => {
    const menu = nativeCommandMenu();
    expect(menu.length).toBeGreaterThan(0);
    expect(menu.length).toBeLessThanOrEqual(100);
    for (const c of menu) {
      expect(c.command).toMatch(/^[a-z0-9_]+$/);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });
});
