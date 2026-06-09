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
    // make isGitRepo() answer "yes"
    if (cmd[1] === "rev-parse") return { code: 0, stdout: "true\n", stderr: "" };
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
