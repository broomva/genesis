import { describe, expect, test } from "bun:test";
import { StaticHostProvider } from "./host-provider";
import type { ExecutionHost } from "./index";
import type { VercelSandboxHandle } from "./sandbox-factory";
import { VercelSandboxHostProvider, aiGatewayEnv } from "./sandbox-provider";

const fakeHost = { kind: "microvm", credentialTier: "keyed" } as unknown as ExecutionHost;

function fakeHandle(name: string): VercelSandboxHandle & { stopped: number } {
  const h = {
    host: fakeHost,
    sandbox: {} as never,
    name,
    stopped: 0,
    stop: async () => {
      h.stopped++;
    },
  };
  return h as unknown as VercelSandboxHandle & { stopped: number };
}

describe("aiGatewayEnv", () => {
  test("points Claude Code at the gateway with an EMPTY ANTHROPIC_API_KEY", () => {
    const env = aiGatewayEnv("tok-123", "anthropic/claude-opus-4.7");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://ai-gateway.vercel.sh");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-123");
    expect(env.ANTHROPIC_API_KEY).toBe(""); // critical: Claude Code checks this first
    expect(env.ANTHROPIC_MODEL).toBe("anthropic/claude-opus-4.7");
  });
  test("omits ANTHROPIC_MODEL when no model is given", () => {
    expect("ANTHROPIC_MODEL" in aiGatewayEnv("t")).toBe(false);
  });
});

describe("StaticHostProvider", () => {
  test("returns the same host + remoteCwd on every lease", async () => {
    const p = new StaticHostProvider(fakeHost, "/vercel/sandbox");
    const a = await p.resolveHost({ id: "s1", threadId: "t1" });
    const b = await p.resolveHost({ id: "s2", threadId: "t2" });
    expect(a.host).toBe(fakeHost);
    expect(a.remoteCwd).toBe("/vercel/sandbox");
    expect(b.host).toBe(fakeHost);
  });
});

describe("VercelSandboxHostProvider — per-session microVMs", () => {
  test("creates one sandbox per session and reuses it across turns", async () => {
    const created: string[] = [];
    const p = new VercelSandboxHostProvider({}, async (o) => {
      created.push(o.sessionName as string);
      return fakeHandle(o.sessionName as string);
    });
    await p.resolveHost({ id: "sess-A", threadId: "tA" });
    await p.resolveHost({ id: "sess-A", threadId: "tA" }); // same session → reuse
    await p.resolveHost({ id: "sess-B", threadId: "tB" }); // new session → new VM
    expect(created).toEqual(["sess-A", "sess-B"]);
    expect(created.filter((n) => n === "sess-A").length).toBe(1);
  });

  test("dedupes concurrent first-creates for the same session", async () => {
    let calls = 0;
    const p = new VercelSandboxHostProvider({}, async (o) => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return fakeHandle(o.sessionName as string);
    });
    await Promise.all([
      p.resolveHost({ id: "sess-C", threadId: "t" }),
      p.resolveHost({ id: "sess-C", threadId: "t" }),
    ]);
    expect(calls).toBe(1); // one VM, not two
  });

  test("passes session name + reuse + the AI Gateway env into create", async () => {
    let seen: Record<string, unknown> = {};
    const p = new VercelSandboxHostProvider({ env: aiGatewayEnv("tok") }, async (o) => {
      seen = o as Record<string, unknown>;
      return fakeHandle(o.sessionName as string);
    });
    await p.resolveHost({ id: "sess-D", threadId: "t" });
    expect(seen.sessionName).toBe("sess-D");
    expect(seen.reuse).toBe(true);
    expect((seen.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe(
      "https://ai-gateway.vercel.sh",
    );
  });

  test("stopAfterTurn → the lease release stops the VM and evicts it", async () => {
    const handles: Array<ReturnType<typeof fakeHandle>> = [];
    const p = new VercelSandboxHostProvider({ stopAfterTurn: true }, async (o) => {
      const h = fakeHandle(o.sessionName as string);
      handles.push(h);
      return h;
    });
    const lease = await p.resolveHost({ id: "sess-E", threadId: "t" });
    await lease.release?.();
    expect(handles[0]?.stopped).toBe(1);
    // evicted → next resolve creates a fresh VM
    await p.resolveHost({ id: "sess-E", threadId: "t" });
    expect(handles.length).toBe(2);
  });

  test("a failed create does not poison the cache (next resolve retries)", async () => {
    let n = 0;
    const p = new VercelSandboxHostProvider({}, async (o) => {
      n++;
      if (n === 1) throw new Error("create blip");
      return fakeHandle(o.sessionName as string);
    });
    await expect(p.resolveHost({ id: "sess-F", threadId: "t" })).rejects.toThrow("create blip");
    const lease = await p.resolveHost({ id: "sess-F", threadId: "t" }); // retried
    expect(lease.host).toBe(fakeHost);
    expect(n).toBe(2);
  });

  test("shutdown stops every warm sandbox", async () => {
    const handles: Array<ReturnType<typeof fakeHandle>> = [];
    const p = new VercelSandboxHostProvider({}, async (o) => {
      const h = fakeHandle(o.sessionName as string);
      handles.push(h);
      return h;
    });
    await p.resolveHost({ id: "s1", threadId: "t" });
    await p.resolveHost({ id: "s2", threadId: "t" });
    await p.shutdown();
    expect(handles.map((h) => h.stopped)).toEqual([1, 1]);
  });
});
