import { describe, expect, test } from "bun:test";
import type { ExecOpts, ExecResult, ExecutionHost, SpawnHandle } from "@genesis/host";
import { runAgent, scrubAgentEnv, tenantEnv } from "./index";

const NDJSON = [
  '{"type":"system","session_id":"s1"}',
  '{"type":"result","subtype":"success","session_id":"s1","result":"done"}',
];

function streamOf(lines: string[]): SpawnHandle {
  async function* gen() {
    for (const l of lines) yield l;
  }
  return { stdout: gen(), exitCode: Promise.resolve(0), kill: () => {} };
}

class FakeLocalHost implements ExecutionHost {
  readonly kind = "local" as const;
  readonly credentialTier = "subscription" as const;
  spawnOpts?: ExecOpts;
  async exec(cmd: string[]): Promise<ExecResult> {
    if (cmd.includes("--show-toplevel")) return { code: 0, stdout: "/repo\n", stderr: "" };
    if (cmd[1] === "rev-parse") return { code: 0, stdout: "true\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }
  spawnStream(_cmd: string[], opts?: ExecOpts): SpawnHandle {
    this.spawnOpts = opts;
    return streamOf(NDJSON);
  }
  async readFile() {
    return "";
  }
  async writeFile() {}
}

// BRO-2235. The point of these is the DEFAULT case: an unset `home` must leave the
// environment exactly as it was, because this is fail-SAFE, not fail-closed. A
// tenant whose home was never provisioned must keep working, not lose its
// credential and fail every turn.
describe("tenantEnv", () => {
  test("unset home → base returned untouched (current behaviour preserved)", () => {
    expect(tenantEnv({})).toBeUndefined();
    expect(tenantEnv({}, { A: "1" })).toEqual({ A: "1" });
  });

  test.each([[""], ["   "]])("blank home %p is treated as unset", (h) => {
    expect(tenantEnv({ home: h }, { A: "1" })).toEqual({ A: "1" });
  });

  test("absolute home sets HOME", () => {
    expect(tenantEnv({ home: "/t/573/home" })).toEqual({ HOME: "/t/573/home" });
  });

  test("merges over a base without dropping it", () => {
    expect(tenantEnv({ home: "/t/h" }, { A: "1" })).toEqual({ A: "1", HOME: "/t/h" });
  });

  // A relative HOME resolves against the CHILD'S CWD — the tenant's own workspace —
  // so `.claude` would land somewhere the tenant can write, handing it its own
  // settings file. That is the opposite of the isolation this exists for.
  test.each([["home"], ["./home"], ["../escape"], ["t/home"]])(
    "relative home %p is REFUSED, falling back to base",
    (h) => {
      expect(tenantEnv({ home: h }, { A: "1" })).toEqual({ A: "1" });
    },
  );

  test("HOME wins over a base that already set it", () => {
    expect(tenantEnv({ home: "/t/h" }, { HOME: "/home/agent" })).toEqual({ HOME: "/t/h" });
  });
});

// THE WIRING, not the pure function. Everything above tests `tenantEnv` in
// isolation, which is exactly what shipped in #122 — and it shipped INERT, with
// zero call sites. A pure function with a passing test suite and no caller looks
// identical to a working feature from the outside. These go through the real
// `runAgent` and read the env the host was actually asked to spawn with.
describe("per-tenant HOME reaches the spawn (BRO-2235)", () => {
  const run = async (home?: string) => {
    const host = new FakeLocalHost();
    await runAgent({ prompt: "go", cwd: "/repo", host, worktree: false, home });
    return host.spawnOpts;
  };

  test("home set → the child spawns with that HOME", async () => {
    const opts = await run("/tenants/573001112233/home");
    expect(opts?.env?.HOME).toBe("/tenants/573001112233/home");
  });

  test("home UNSET → HOME is the server's, i.e. current behaviour is preserved", async () => {
    const opts = await run(undefined);
    expect(opts?.env?.HOME).toBe(scrubAgentEnv().HOME);
  });

  // DEFENSE IN DEPTH, NOT THE CONTRACT — and the distinction is the whole point.
  //
  // An earlier version of this test asserted exactly this and called it correct.
  // It is not: a workspace carrying `home: "relative/home"` has REQUESTED isolation,
  // and falling back to the operator's HOME serves that tenant from the operator's
  // credential while looking like a normal turn. Cross-model review found it, and
  // this test was the reason it survived review — it read as an intended behaviour.
  //
  // `homeRefusal` (packages/core/src/supervisor.ts) now refuses such a turn before
  // any spawn happens, so this path is unreachable in practice. The behaviour is
  // kept and pinned only as a LAST line of defense: if a relative home ever reaches
  // here, resolving it would put HOME inside the child's cwd — the tenant's own
  // writable directory — handing the tenant its own .claude/settings.json. Dropping
  // it is the lesser of two bad outcomes, not a good one.
  test("a relative home is dropped, not resolved against the child cwd", async () => {
    const opts = await run("relative/home");
    expect(opts?.env?.HOME).toBe(scrubAgentEnv().HOME);
    expect(opts?.env?.HOME).not.toContain("relative/home");
  });

  test("HOME is layered ON the scrubbed env — PATH survives, secrets stay scrubbed", async () => {
    const opts = await run("/tenants/x/home");
    expect(opts?.env?.PATH).toBe(scrubAgentEnv().PATH);
    // replaceEnv is true, so this object IS the child's whole environment. If the
    // tenant home were passed alone the child would have no PATH and would not
    // resolve its own binary.
    expect(opts?.replaceEnv).toBe(true);
    expect(Object.keys(opts?.env ?? {}).length).toBeGreaterThan(1);
  });

  test("scrubbing still wins over the tenant home for denied names", async () => {
    // Order is scrub-then-HOME, so a tenant home cannot smuggle a denied var back.
    const opts = await run("/tenants/x/home");
    for (const k of Object.keys(opts?.env ?? {})) {
      expect(k.startsWith("GENESIS_")).toBe(false);
    }
  });
});
