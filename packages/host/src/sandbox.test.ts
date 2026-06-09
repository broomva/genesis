import { describe, expect, test } from "bun:test";
import {
  type SandboxCommandLike,
  type SandboxLike,
  VercelSandboxHost,
  linesFromLogs,
} from "./sandbox";
import { applyBootstrap } from "./sandbox-factory";

type LogEntry = { stream: "stdout" | "stderr"; data: string };

function fakeCommand(logs: LogEntry[], exit = 0): SandboxCommandLike & { killed: string[] } {
  const killed: string[] = [];
  return {
    killed,
    exitCode: exit,
    async *logs() {
      for (const l of logs) yield l;
    },
    async wait() {
      return { exitCode: exit };
    },
    async kill(signal = "SIGTERM") {
      killed.push(signal);
    },
    async stdout() {
      return logs
        .filter((l) => l.stream === "stdout")
        .map((l) => l.data)
        .join("");
    },
    async stderr() {
      return logs
        .filter((l) => l.stream === "stderr")
        .map((l) => l.data)
        .join("");
    },
  };
}

class FakeSandbox implements SandboxLike {
  runCalls: Array<{ cmd: string; args?: string[]; cwd?: string; detached?: boolean }> = [];
  written: Array<{ path: string; content: Buffer }> = [];
  stopped = false;
  lastCommand?: ReturnType<typeof fakeCommand>;
  constructor(
    private readonly script: (cmd: string, args: string[]) => { logs: LogEntry[]; exit?: number },
    private readonly files: Record<string, string | null> = {},
  ) {}
  async runCommand(p: { cmd: string; args?: string[]; cwd?: string; detached?: boolean }) {
    this.runCalls.push(p);
    const { logs, exit } = this.script(p.cmd, p.args ?? []);
    const c = fakeCommand(logs, exit ?? 0);
    this.lastCommand = c;
    return c;
  }
  async readFileToBuffer({ path }: { path: string }) {
    const v = this.files[path];
    return v == null ? null : Buffer.from(v, "utf8");
  }
  async writeFiles(files: Array<{ path: string; content: Buffer }>) {
    this.written.push(...files);
  }
  async snapshot() {
    return { snapshotId: "snap-123" };
  }
  async stop() {
    this.stopped = true;
    return {};
  }
}

describe("linesFromLogs", () => {
  test("reassembles lines split across chunks and keeps only the chosen stream", async () => {
    async function* logs() {
      yield { stream: "stdout" as const, data: "he" };
      yield { stream: "stderr" as const, data: "NOISE\n" };
      yield { stream: "stdout" as const, data: "llo\nwor" };
      yield { stream: "stdout" as const, data: "ld\n" };
    }
    const out: string[] = [];
    for await (const l of linesFromLogs(logs(), "stdout")) out.push(l);
    expect(out).toEqual(["hello", "world"]);
  });

  test("flushes a final line with no trailing newline", async () => {
    async function* logs() {
      yield { stream: "stdout" as const, data: "tail-no-newline" };
    }
    const out: string[] = [];
    for await (const l of linesFromLogs(logs(), "stdout")) out.push(l);
    expect(out).toEqual(["tail-no-newline"]);
  });
});

describe("VercelSandboxHost", () => {
  test("identifies as a keyed microVM", () => {
    const host = new VercelSandboxHost(new FakeSandbox(() => ({ logs: [] })));
    expect(host.kind).toBe("microvm");
    expect(host.credentialTier).toBe("keyed");
  });

  test("exec returns exit code, stdout, and stderr", async () => {
    const sb = new FakeSandbox(() => ({
      logs: [
        { stream: "stdout", data: "v2.1.1\n" },
        { stream: "stderr", data: "warn\n" },
      ],
      exit: 0,
    }));
    const host = new VercelSandboxHost(sb);
    const r = await host.exec(["node", "--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("v2.1.1\n");
    expect(r.stderr).toBe("warn\n");
    expect(sb.runCalls[0]).toMatchObject({ cmd: "node", args: ["--version"] });
  });

  test("spawnStream yields stdout lines, resolves exit code, and kills with SIGKILL", async () => {
    const sb = new FakeSandbox(() => ({
      logs: [
        { stream: "stdout", data: '{"type":"system"}\n{"type":' },
        { stream: "stderr", data: "ignored diagnostic\n" },
        { stream: "stdout", data: '"result"}\n' },
      ],
      exit: 0,
    }));
    const host = new VercelSandboxHost(sb);
    const handle = host.spawnStream(["claude", "-p", "hi"], { cwd: "/vercel/sandbox" });
    const lines: string[] = [];
    for await (const l of handle.stdout) lines.push(l);
    expect(lines).toEqual(['{"type":"system"}', '{"type":"result"}']);
    expect(await handle.exitCode).toBe(0);
    handle.kill();
    await new Promise((r) => setTimeout(r, 0));
    expect(sb.lastCommand?.killed).toContain("SIGKILL");
    expect(sb.runCalls[0]).toMatchObject({ cmd: "claude", detached: true, cwd: "/vercel/sandbox" });
  });

  test("readFile returns content and throws when the file is absent", async () => {
    const sb = new FakeSandbox(() => ({ logs: [] }), { "a.txt": "hello", "gone.txt": null });
    const host = new VercelSandboxHost(sb);
    expect(await host.readFile("a.txt")).toBe("hello");
    await expect(host.readFile("gone.txt")).rejects.toThrow("does not exist");
  });

  test("writeFile uploads a utf8 buffer", async () => {
    const sb = new FakeSandbox(() => ({ logs: [] }));
    const host = new VercelSandboxHost(sb);
    await host.writeFile("out.txt", "données");
    expect(sb.written[0]?.path).toBe("out.txt");
    expect(sb.written[0]?.content.toString("utf8")).toBe("données");
  });

  test("snapshot returns the snapshot id and stop tears the VM down", async () => {
    const sb = new FakeSandbox(() => ({ logs: [] }));
    const host = new VercelSandboxHost(sb);
    expect(await host.snapshot()).toBe("snap-123");
    await host.stop();
    expect(sb.stopped).toBe(true);
  });
});

describe("linesFromLogs — F16 line cap", () => {
  test("throws when an un-newlined stream exceeds the 16 MiB cap", async () => {
    async function* huge() {
      // 17 x 1 MiB chunks, no newline → must trip the cap before OOM
      for (let i = 0; i < 17; i++)
        yield { stream: "stdout" as const, data: "x".repeat(1024 * 1024) };
    }
    await expect(
      (async () => {
        for await (const _ of linesFromLogs(huge(), "stdout")) {
          /* drain */
        }
      })(),
    ).rejects.toThrow("16 MiB");
  });
});

describe("applyBootstrap — never leak a VM on failure (P20 HIGH-1)", () => {
  test("stops the sandbox and throws when a bootstrap command fails", async () => {
    const sb = new FakeSandbox((cmd) => ({
      logs: [{ stream: "stderr", data: "boom" }],
      exit: cmd === "false" ? 1 : 0,
    }));
    await expect(applyBootstrap(sb, [["false"]])).rejects.toThrow("bootstrap failed");
    expect(sb.stopped).toBe(true); // VM torn down, not leaked
  });

  test("runs all commands and does not stop on success", async () => {
    const sb = new FakeSandbox(() => ({ logs: [], exit: 0 }));
    await applyBootstrap(sb, [
      ["npm", "i", "-g", "@anthropic-ai/claude-code"],
      ["node", "-v"],
    ]);
    expect(sb.runCalls.map((c) => c.cmd)).toEqual(["npm", "node"]);
    expect(sb.stopped).toBe(false);
  });
});
