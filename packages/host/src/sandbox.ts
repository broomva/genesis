// VercelSandboxHost — the microVM tier of ExecutionHost (Genesis Phase 4).
//
// Backed by Vercel Sandbox: Firecracker microVMs (the best snapshot-resume fit
// per the agent-sandbox-substrate KG survey), persistent-by-default with a
// snapshot API, and `deny-all` egress. Host ownership here means:
//   persistence  → snapshot (sandbox.snapshot(); persistent-by-default)
//   credentials  → KEYED, boundary-injected (ANTHROPIC_API_KEY in sandbox env),
//                  never the user's subscription OAuth (2026 ToS: no subscription
//                  OAuth on non-owned compute).
//
// Structurally typed against `SandboxLike` (the slice of @vercel/sandbox we use)
// so it is unit-testable with an injected fake — CI needs no cloud credentials.

import {
  type ExecOpts,
  type ExecResult,
  type ExecutionHost,
  MAX_LINE_BYTES,
  type SpawnHandle,
} from "./index";

/** A detached command handle (subset of @vercel/sandbox `Command`). */
export interface SandboxCommandLike {
  logs(): AsyncIterable<{ stream: "stdout" | "stderr"; data: string }>;
  wait(): Promise<{ exitCode: number | null }>;
  kill(signal?: string): Promise<void>;
  stdout(): Promise<string>;
  stderr(): Promise<string>;
  exitCode: number | null;
}

/** The slice of the @vercel/sandbox `Sandbox` instance VercelSandboxHost uses. */
export interface SandboxLike {
  runCommand(params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    sudo?: boolean;
    detached?: boolean;
  }): Promise<SandboxCommandLike>;
  readFileToBuffer(params: { path: string }): Promise<Buffer | null>;
  writeFiles(files: Array<{ path: string; content: Buffer; mode?: number }>): Promise<void>;
  snapshot(): Promise<{ snapshotId?: string; id?: string }>;
  stop(): Promise<unknown>;
}

/** Re-frame string `data` chunks (which may split/merge lines) into whole lines,
 *  keeping only the requested stream. Mirrors host.ts `toLines` for chunk input. */
export async function* linesFromLogs(
  logs: AsyncIterable<{ stream: "stdout" | "stderr"; data: string }>,
  stream: "stdout" | "stderr",
): AsyncGenerator<string> {
  let buf = "";
  for await (const entry of logs) {
    if (entry.stream !== stream) continue;
    buf += entry.data;
    if (buf.length > MAX_LINE_BYTES) throw new Error("line exceeds 16 MiB cap"); // F16
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      yield buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      idx = buf.indexOf("\n");
    }
  }
  if (buf.length > 0) yield buf;
}

export class VercelSandboxHost implements ExecutionHost {
  readonly kind = "microvm" as const;
  readonly credentialTier = "keyed" as const;

  constructor(private readonly sandbox: SandboxLike) {}

  spawnStream(cmd: string[], opts?: ExecOpts): SpawnHandle {
    if (cmd.length === 0) throw new Error("spawnStream: empty command");
    // The sandbox SDK's runCommand has no stdin channel, so an `input` payload
    // (the large-prompt-via-stdin path, BRO-1642) is appended as a trailing
    // positional arg — `claude -p … <prompt>` — preserving the pre-BRO-1642
    // behavior on the microVM host. (This retains the OS argv cap on the sandbox;
    // lifting it there — writeFiles + `sh -c 'claude -p < file'` — is a follow-up.)
    const args = cmd.slice(1);
    if (opts?.input !== undefined) args.push(opts.input);
    const cmdPromise = this.sandbox.runCommand({
      cmd: cmd[0] as string,
      args,
      cwd: opts?.cwd,
      env: opts?.env,
      detached: true,
    });
    async function* stdout(): AsyncGenerator<string> {
      const command = await cmdPromise;
      yield* linesFromLogs(command.logs(), "stdout");
    }
    const exitCode = cmdPromise.then((c) => c.wait()).then((r) => r.exitCode ?? -1);
    const kill = () => {
      void cmdPromise.then((c) => c.kill("SIGKILL")).catch(() => {});
    };
    return { stdout: stdout(), exitCode, kill };
  }

  async exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult> {
    if (cmd.length === 0) throw new Error("exec: empty command");
    const command = await this.sandbox.runCommand({
      cmd: cmd[0] as string,
      args: cmd.slice(1),
      cwd: opts?.cwd,
      env: opts?.env,
    });
    const [stdout, stderr] = await Promise.all([command.stdout(), command.stderr()]);
    return { code: command.exitCode ?? -1, stdout, stderr };
  }

  async readFile(path: string): Promise<string> {
    const buf = await this.sandbox.readFileToBuffer({ path });
    if (buf === null) throw new Error(`sandbox readFile: ${path} does not exist`);
    return buf.toString("utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.sandbox.writeFiles([{ path, content: Buffer.from(content, "utf8") }]);
  }

  /** Optional ExecutionHost capability — lit up because Vercel Sandbox snapshots.
   *  Returns the snapshot id for later restore (source: { snapshot }).
   *  NOTE: per the @vercel/sandbox API, taking an explicit snapshot STOPS the VM.
   *  For graceful shutdown prefer stop() — persistent-by-default auto-snapshots on
   *  stop and the VM resumes via Sandbox.get({ name }) without an explicit id. */
  async snapshot(): Promise<string> {
    const snap = await this.sandbox.snapshot();
    const id = snap.snapshotId ?? snap.id;
    if (!id) throw new Error("sandbox snapshot returned no id");
    return id;
  }

  /** Tear down the microVM (persistent-by-default → auto-snapshots on stop). */
  async stop(): Promise<void> {
    await this.sandbox.stop();
  }
}
