// ExecutionHost — the host-invariant seam. Above it, all Genesis code is
// identical; below it, the host varies. The arc's sharpest insight:
// host ownership determines BOTH persistence AND credential tier.
//
//   kind     persistence            credentialTier   phase
//   local    ephemeral (this box)   subscription     1  (implemented)
//   vps      durable (user box)     subscription     1  (implemented, ssh)
//   microvm  snapshot-suspend       keyed            4  (deferred; snapshot?)

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SpawnHandle {
  /** Line-oriented stdout stream (NDJSON-ready). */
  stdout: AsyncIterable<string>;
  /** Resolves with the process exit code. */
  exitCode: Promise<number>;
  kill(): void;
}

export interface ExecutionHost {
  readonly kind: "local" | "vps" | "microvm";
  /** Owned hosts (local/vps) are subscription-OAuth-clean; microvm is keyed. */
  readonly credentialTier: "subscription" | "keyed";
  exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult>;
  spawnStream(cmd: string[], opts?: ExecOpts): SpawnHandle;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Phase 4 (microVM) only — memory-snapshot suspend. Optional in the seam. */
  snapshot?(): Promise<string>;
}

/** Cap a single un-newlined line at 16 MiB so a runaway/malicious agent
 *  emitting one giant line cannot OOM the host (F16). Shared by every host's
 *  line-buffering path (LocalHost toLines + VercelSandboxHost linesFromLogs). */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** POSIX single-quote a string for safe interpolation into a remote shell. */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/** Convert a byte ReadableStream into an async generator of text lines. */
export async function* toLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.length > MAX_LINE_BYTES) throw new Error("line exceeds 16 MiB cap");
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        yield buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
      }
    }
    if (buf.length > 0) yield buf;
  } finally {
    reader.releaseLock();
  }
}

/** LocalHost — runs on this machine via Bun.spawn. Phase 1 default. */
export class LocalHost implements ExecutionHost {
  readonly kind = "local" as const;
  readonly credentialTier = "subscription" as const;

  spawnStream(cmd: string[], opts?: ExecOpts): SpawnHandle {
    // stderr is "ignore" (not "pipe"): an undrained pipe would deadlock the
    // child once its stderr buffer fills, stalling stdout/the reducer (F15).
    const proc = Bun.spawn(cmd, {
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env },
      stdout: "pipe",
      stderr: "ignore",
    });
    return { stdout: toLines(proc.stdout), exitCode: proc.exited, kill: () => proc.kill() };
  }

  async exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult> {
    const proc = Bun.spawn(cmd, {
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  async readFile(path: string): Promise<string> {
    return Bun.file(path).text();
  }

  async writeFile(path: string, content: string): Promise<void> {
    await Bun.write(path, content);
  }
}

/** VpsHost — a user-owned remote box over `ssh`. Same code above the seam.
 *  Dependency-free: wraps commands through the local `ssh` binary, so it is
 *  subscription-OAuth-clean (user owns the box). All interpolated values are
 *  single-quote escaped (F8/F9). MicroVMHost (Phase 4) adds snapshot() + the
 *  keyed-credential boundary. */
export class VpsHost implements ExecutionHost {
  readonly kind = "vps" as const;
  readonly credentialTier = "subscription" as const;
  private readonly local = new LocalHost();

  constructor(
    private readonly target: string, // e.g. "deploy@host.example.com"
    private readonly remoteCwd?: string,
  ) {}

  private wrap(cmd: string[]): string[] {
    const cd = this.remoteCwd ? `cd ${shQuote(this.remoteCwd)} && ` : "";
    const joined = cmd.map(shQuote).join(" ");
    return ["ssh", this.target, "--", `${cd}${joined}`];
  }

  spawnStream(cmd: string[], opts?: ExecOpts): SpawnHandle {
    return this.local.spawnStream(this.wrap(cmd), { env: opts?.env });
  }
  exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult> {
    return this.local.exec(this.wrap(cmd), { env: opts?.env });
  }
  async readFile(path: string): Promise<string> {
    const r = await this.exec(["cat", path]);
    if (r.code !== 0) throw new Error(`vps readFile ${path} failed (${r.code}): ${r.stderr}`);
    return r.stdout;
  }
  async writeFile(path: string, content: string): Promise<void> {
    const cd = this.remoteCwd ? `cd ${shQuote(this.remoteCwd)} && ` : "";
    const proc = Bun.spawn(["ssh", this.target, "--", `${cd}cat > ${shQuote(path)}`], {
      stdin: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(content);
    await proc.stdin.end();
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`vps writeFile ${path} failed (${code}): ${err}`);
    }
  }
}

export {
  type SandboxCommandLike,
  type SandboxLike,
  VercelSandboxHost,
  linesFromLogs,
} from "./sandbox";
export {
  DEFAULT_AGENT_ALLOWLIST,
  type SandboxNetworkPolicy,
  type SandboxRuntime,
  type VercelSandboxHandle,
  type VercelSandboxOptions,
  applyBootstrap,
  createVercelSandboxHost,
} from "./sandbox-factory";
