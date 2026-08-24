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
  /** When true, `env` REPLACES the inherited process.env instead of extending
   *  it. Used to spawn the agent with a scrubbed env so a prompt-injected agent
   *  cannot read the host's operational secrets (BRO-1527 #1). Default false
   *  (extend) keeps framework git/exec calls working with the full host env. */
  replaceEnv?: boolean;
  /** Content to write to the child's stdin, then close it (EOF). Used to keep a
   *  LARGE payload (the agent prompt, which inlines file attachments) OFF argv —
   *  a single argv element over the OS cap (Linux MAX_ARG_STRLEN = 128 KiB;
   *  Windows 32,767 chars) fails the spawn with E2BIG. `claude -p` with no
   *  positional prompt reads it from stdin (BRO-1642, Houston channel-split). */
  input?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** How long after a handle settles its kills are still delivered (BRO-2260).
 *
 *  Long enough to cover the runner's own `finally` and its SIGKILL escalation
 *  (5s), and far shorter than any realistic pid-recycling interval.
 *
 *  MEASURED on the production host rather than assumed: `pid_max` is 4,194,304 and
 *  the box averages 1.69 forks/sec (126,611 forks over 74,928s of uptime). Wrapping
 *  the pid space therefore takes on the order of 29 DAYS; this window is 30
 *  SECONDS. Inside it roughly 51 pids are issued out of four million, so a signal
 *  delivered here cannot reach a recycled pid. If this ever runs somewhere with a
 *  small `pid_max` and a very high fork rate, shorten it — the number is a
 *  consequence of those two facts, not a preference. */
const SETTLE_GRACE_MS = 30_000;

export interface SpawnHandle {
  /** Line-oriented stdout stream (NDJSON-ready). */
  stdout: AsyncIterable<string>;
  /** Resolves with the process exit code. */
  exitCode: Promise<number>;
  /** Terminate the child. Defaults to SIGTERM.
   *
   *  A caller that must GUARANTEE termination has to escalate: a child which
   *  traps SIGTERM keeps its stdout open, and a reader sitting in
   *  `for await (… of handle.stdout)` then waits forever. Measured on this host:
   *  `bash -c "trap '' TERM; …"` survived `kill()` and the stream never ended.
   *  See the escalation in the runner's watchdog (BRO-2260). */
  kill(signal?: NodeJS.Signals): void;
}

export interface ExecutionHost {
  readonly kind: "local" | "vps" | "microvm";
  /** Owned hosts (local/vps) are subscription-OAuth-clean; microvm is keyed. */
  readonly credentialTier: "subscription" | "keyed";
  exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult>;
  spawnStream(cmd: string[], opts?: ExecOpts): SpawnHandle;
  readFile(path: string): Promise<string>;
  /** Write a file. `content` may be binary (Uint8Array) so image/PDF attachments
   *  materialize byte-exact — a string would UTF-8-mangle binary (BRO-1706). */
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
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
    // stdin is piped only when `input` is supplied (the large-prompt path,
    // BRO-1642); otherwise "ignore" (child gets /dev/null → immediate EOF). NOT
    // "inherit": a headless server must never hand its own stdin to a child (a
    // non-input caller like the codex runner would otherwise read the server's
    // stdin and could hang on a TTY/pipe). "ignore" matches Bun's headless default.
    const proc = Bun.spawn(cmd, {
      cwd: opts?.cwd,
      env: opts?.replaceEnv ? (opts.env ?? {}) : { ...process.env, ...opts?.env },
      stdin: opts?.input !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "ignore",
      // DETACHED so the child leads its own process GROUP (BRO-2260). Killing the
      // direct pid is not enough: an agent turn is `claude` -> `bash` -> `git
      // clone`, and MEASURED here, SIGKILL on the parent left the grandchild alive
      // AND the stdout stream open, so the reader waited forever. With its own
      // group, `kill(-pgid)` reaps the whole tree in one call.
      //
      // Verified on this platform: `detached: true` yields pgid === child pid and
      // a pgid distinct from ours, which is what makes the negative-pid kill below
      // safe — it can never address the group this process lives in.
      detached: true,
    });
    if (opts?.input !== undefined && proc.stdin) {
      // Write the whole payload then close stdin so the child sees EOF and starts.
      // Swallow pipe errors (EPIPE if the child exits before reading stdin) so they
      // don't become an unhandled rejection — the turn still resolves via exitCode
      // (CodeRabbit).
      try {
        proc.stdin.write(opts.input);
        // end() returns number | Promise<number> — normalize so a rejected flush
        // (broken pipe) is caught rather than becoming an unhandled rejection.
        void Promise.resolve(proc.stdin.end()).catch(() => {});
      } catch {
        // child closed stdin before we finished writing — proceed; exitCode reports it.
      }
    }
    // SETTLEMENT IS GROUP-WIDE, NOT CHILD-WIDE (P20 round 3).
    //
    // The first version of this guard latched on `proc.exited` alone, to avoid
    // signalling a recycled pid. That was wrong in a way the descendant test did
    // not cover: on SIGTERM a COMPLIANT leader exits immediately while a
    // TERM-ignoring descendant keeps running and keeps stdout open. `exited`
    // resolves, the latch suppresses the escalation's SIGKILL, and the turn — plus
    // the admission slot it holds — hangs forever. The guard against one hazard
    // reintroduced the exact hazard it was added beside.
    //
    // CORRECTED (P20 round 5): child-exit plus stdout-closure does NOT prove the
    // group is gone — a descendant that redirects its output closes the stream and
    // keeps running, which is the regression in kill-escalation.test.ts. These two
    // conditions only mark when the handle STOPPED BEING USED; the kill guard below
    // is a time window from that moment, not a claim about the group.
    let exited = false;
    let streamClosed = false;
    let settledAt: number | undefined;
    const markSettled = () => {
      if (exited && streamClosed && settledAt === undefined) settledAt = Date.now();
    };
    void proc.exited.then(
      () => {
        exited = true;
        markSettled();
      },
      () => {
        exited = true;
        markSettled();
      },
    );
    const lines = toLines(proc.stdout);
    const trackedStdout = (async function* () {
      try {
        yield* lines;
      } finally {
        streamClosed = true;
        markSettled();
      }
    })();
    return {
      stdout: trackedStdout,
      exitCode: proc.exited,
      kill: (signal?: NodeJS.Signals) => {
        // SUPPRESS ONLY LONG AFTER SETTLEMENT (P20 round 4).
        //
        // Round 3 replaced an exit-only latch with `exited && streamClosed`. Round
        // 4 found the hole that leaves: a descendant which does `exec >/dev/null`
        // CLOSES stdout, so the stream ends, the handle reads as settled, and the
        // caller's final kill is suppressed while that process keeps running.
        // Reproduced independently — the descendant survived. That is the incident's
        // own shape (a build or clone that redirects its output), so suppressing
        // there defeats the purpose of the bound.
        //
        // The hazard the latch exists for is a signal sent LONG after the handle is
        // finished, once the OS may have reissued the pid. A kill issued moments
        // after settlement — the runner's `finally`, or its escalation timer — is
        // not that. So the guard is a time window, not a state flag: within
        // SETTLE_GRACE_MS every kill still goes through, and only a genuinely stale
        // one is dropped. A pid cannot realistically be recycled inside that window.
        if (settledAt !== undefined && Date.now() - settledAt > SETTLE_GRACE_MS) return;
        const sig = signal ?? "SIGTERM";
        // Group first, then the bare pid as a fallback. If the group kill throws
        // (ESRCH — the leader already reaped, or `detached` silently stopped
        // working) we still terminate the direct child, so this is never worse
        // than the old behaviour. `pid > 1` guards the "kill everything" pid 0/-1
        // footgun, which would take the whole server down.
        const pid = proc.pid;
        if (typeof pid === "number" && pid > 1) {
          try {
            process.kill(-pid, sig);
            return;
          } catch {
            // fall through to the single-process kill
          }
        }
        try {
          proc.kill(sig);
        } catch {
          // already gone — kill() must never throw into a caller's `finally`
        }
      },
    };
  }

  async exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult> {
    const proc = Bun.spawn(cmd, {
      cwd: opts?.cwd,
      env: opts?.replaceEnv ? (opts.env ?? {}) : { ...process.env, ...opts?.env },
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

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    // Bun.write accepts string | TypedArray and creates parent dirs as needed.
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

  // NOTE: `env`/`replaceEnv` here scope the LOCAL ssh-client process, not the
  // remote agent — ssh does not forward arbitrary env. Remote-side secret
  // scrubbing is a separate (VPS) concern (BRO-1527 #2/#3); the env-leak fixed
  // here is LocalHost's inherited process.env. Passed through for interface
  // parity so a scrubbed-env caller behaves consistently across hosts.
  spawnStream(cmd: string[], opts?: ExecOpts): SpawnHandle {
    // `input` is forwarded to the LOCAL ssh process's stdin; ssh relays it to the
    // remote command's stdin, so the large-prompt-via-stdin path (BRO-1642) works
    // transparently over the VPS host too.
    return this.local.spawnStream(this.wrap(cmd), {
      env: opts?.env,
      replaceEnv: opts?.replaceEnv,
      input: opts?.input,
    });
  }
  exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult> {
    return this.local.exec(this.wrap(cmd), { env: opts?.env, replaceEnv: opts?.replaceEnv });
  }
  async readFile(path: string): Promise<string> {
    const r = await this.exec(["cat", path]);
    if (r.code !== 0) throw new Error(`vps readFile ${path} failed (${r.code}): ${r.stderr}`);
    return r.stdout;
  }
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    // Ensure the parent dir exists (remote `cat >` won't create it — unlike
    // Bun.write locally), so attachment writes into a fresh dir succeed (BRO-1706).
    const dir = path.replace(/\/[^/]*$/, "");
    if (dir && dir !== path) await this.exec(["mkdir", "-p", dir]);
    const cd = this.remoteCwd ? `cd ${shQuote(this.remoteCwd)} && ` : "";
    const proc = Bun.spawn(["ssh", this.target, "--", `${cd}cat > ${shQuote(path)}`], {
      stdin: "pipe",
      stderr: "pipe",
    });
    // Bun's FileSink.write takes string | ArrayBufferView — Uint8Array rides raw
    // over ssh stdin to remote `cat`, preserving binary (BRO-1706).
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
  AGENT_LLM_HOST,
  DEFAULT_AGENT_ALLOWLIST,
  type SandboxNetworkPolicy,
  type SandboxNetworkRule,
  type SandboxRuntime,
  type VercelSandboxHandle,
  type VercelSandboxOptions,
  allowListOmitsGatewayHost,
  applyBootstrap,
  createVercelSandboxHost,
} from "./sandbox-factory";
export {
  type HostLease,
  type HostProvider,
  type HostSession,
  StaticHostProvider,
} from "./host-provider";
export {
  type SandboxCreator,
  type VercelSandboxProviderOptions,
  VercelSandboxHostProvider,
  aiGatewayEnv,
} from "./sandbox-provider";
