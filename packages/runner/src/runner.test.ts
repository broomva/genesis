import { describe, expect, test } from "bun:test";
import type { ExecOpts, ExecResult, ExecutionHost, SpawnHandle } from "@genesis/host";
import { runAgent } from "./index";

const NDJSON = [
  '{"type":"system","session_id":"s1"}',
  '{"type":"assistant","session_id":"s1","message":{"content":[{"type":"text","text":"hi"}]}}',
  '{"type":"result","subtype":"success","session_id":"s1","result":"done"}',
];

function streamOf(lines: string[]): SpawnHandle {
  async function* gen() {
    for (const l of lines) yield l;
  }
  return { stdout: gen(), exitCode: Promise.resolve(0), kill: () => {} };
}

class FakeMicroVMHost implements ExecutionHost {
  readonly kind = "microvm" as const;
  readonly credentialTier = "keyed" as const;
  execCalls: string[][] = [];
  spawnCwd?: string;
  async exec(cmd: string[]): Promise<ExecResult> {
    this.execCalls.push(cmd);
    return { code: 0, stdout: "", stderr: "" };
  }
  spawnStream(_cmd: string[], opts?: ExecOpts): SpawnHandle {
    this.spawnCwd = opts?.cwd;
    return streamOf(NDJSON);
  }
  async readFile() {
    return "";
  }
  async writeFile() {}
}

class FakeLocalHost implements ExecutionHost {
  readonly kind = "local" as const;
  readonly credentialTier = "subscription" as const;
  execCalls: string[][] = [];
  spawnCwd?: string;
  async exec(cmd: string[]): Promise<ExecResult> {
    this.execCalls.push(cmd);
    if (cmd.includes("--show-toplevel")) return { code: 0, stdout: "/repo\n", stderr: "" };
    if (cmd[1] === "rev-parse") return { code: 0, stdout: "true\n", stderr: "" }; // isGitRepo → yes
    return { code: 0, stdout: "", stderr: "" };
  }
  spawnStream(_cmd: string[], opts?: ExecOpts): SpawnHandle {
    this.spawnCwd = opts?.cwd;
    return streamOf(NDJSON);
  }
  async readFile() {
    return "";
  }
  async writeFile() {}
}

describe("runAgent — microVM host", () => {
  test("does NOT cut a git worktree (the VM is the isolation boundary)", async () => {
    const host = new FakeMicroVMHost();
    const r = await runAgent({ prompt: "go", cwd: "/irrelevant/local", host });
    expect(host.execCalls.some((c) => c.includes("worktree"))).toBe(false);
    expect(host.execCalls.some((c) => c.includes("rev-parse"))).toBe(false);
    expect(r.state.phase).toBe("done");
    expect(r.worktreePath).toBeUndefined();
  });

  test("runs at remoteCwd when provided", async () => {
    const host = new FakeMicroVMHost();
    await runAgent({ prompt: "go", cwd: "/irrelevant", host, remoteCwd: "/vercel/sandbox/app" });
    expect(host.spawnCwd).toBe("/vercel/sandbox/app");
  });
});

describe("runAgent — local host worktree", () => {
  test("runs the agent INSIDE the cut worktree, not the main tree", async () => {
    const host = new FakeLocalHost();
    const r = await runAgent({ prompt: "go", cwd: "/repo", host });
    expect(r.worktreePath).toBeDefined();
    expect(host.spawnCwd).toBe(r.worktreePath); // the latent-bug regression guard
    expect(host.spawnCwd).not.toBe("/repo");
  });

  test("worktree:false runs directly at cwd", async () => {
    const host = new FakeLocalHost();
    await runAgent({ prompt: "go", cwd: "/repo", host, worktree: false });
    expect(host.spawnCwd).toBe("/repo");
  });
});

// A local host whose `git worktree list` output is configurable, and that counts
// `git worktree add` invocations — to exercise the per-session reuse path (BRO-1473).
class ConfigurableLocalHost implements ExecutionHost {
  readonly kind = "local" as const;
  readonly credentialTier = "subscription" as const;
  addCalls = 0;
  spawnCwd?: string;
  constructor(private worktreeListOut = "") {}
  async exec(cmd: string[]): Promise<ExecResult> {
    if (cmd.includes("--show-toplevel")) return { code: 0, stdout: "/repo\n", stderr: "" };
    if (cmd[1] === "rev-parse") return { code: 0, stdout: "true\n", stderr: "" };
    if (cmd[1] === "worktree" && cmd[2] === "list") {
      return { code: 0, stdout: this.worktreeListOut, stderr: "" };
    }
    if (cmd[1] === "worktree" && cmd[2] === "add") {
      this.addCalls++;
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }
  spawnStream(_cmd: string[], opts?: ExecOpts): SpawnHandle {
    this.spawnCwd = opts?.cwd;
    return streamOf(NDJSON);
  }
  async readFile() {
    return "";
  }
  async writeFile() {}
}

describe("runAgent — per-session worktree (BRO-1473)", () => {
  test("sessionKey → stable `session-<key>` worktree, marked persistent", async () => {
    const host = new ConfigurableLocalHost("");
    const r = await runAgent({ prompt: "go", cwd: "/repo", host, sessionKey: "sess-9" });
    expect(r.worktreePath).toBe("/repo/.genesis-runs/session-sess-9");
    expect(r.worktreePersistent).toBe(true);
    expect(host.spawnCwd).toBe("/repo/.genesis-runs/session-sess-9");
    expect(host.addCalls).toBe(1); // created (didn't exist)
  });

  test("REUSES an existing session worktree — no second `worktree add` (resume continuity)", async () => {
    // git worktree list reports the session worktree already exists
    const existing = "worktree /repo/.genesis-runs/session-sess-9\nHEAD abc\n";
    const host = new ConfigurableLocalHost(existing);
    const r = await runAgent({ prompt: "second turn", cwd: "/repo", host, sessionKey: "sess-9" });
    expect(host.addCalls).toBe(0); // reused, not re-added
    expect(host.spawnCwd).toBe("/repo/.genesis-runs/session-sess-9"); // same cwd → claude --resume works
    expect(r.worktreePersistent).toBe(true);
  });

  test("existence check is line-exact — session-9 does NOT false-match an existing session-90", async () => {
    // only session-sess-90 exists; asking for session-sess-9 must still CREATE
    const host = new ConfigurableLocalHost(
      "worktree /repo/.genesis-runs/session-sess-90\nHEAD a\n",
    );
    await runAgent({ prompt: "go", cwd: "/repo", host, sessionKey: "sess-9" });
    expect(host.addCalls).toBe(1); // not fooled by the substring
  });

  test("without sessionKey, a one-shot run uses a per-run worktree (not persistent)", async () => {
    const host = new ConfigurableLocalHost("");
    const r = await runAgent({ prompt: "go", cwd: "/repo", host });
    expect(r.worktreePersistent).toBeFalsy();
    expect(r.worktreePath).toContain("/repo/.genesis-runs/run-");
  });
});
