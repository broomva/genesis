// Runner — spawns the coding-agent CLI in stream-json mode inside an isolated
// git worktree on a given ExecutionHost, and folds its NDJSON output through
// the projection reducer into a live RunState. Reuses Houston's claude_runner +
// session_id_tracker learnings (resume by session id; worktree isolation).

import { type ExecutionHost, LocalHost } from "@genesis/host";
import {
  type AgentEvent,
  type RunState,
  initialState,
  parseLine,
  reduce,
} from "@genesis/projection";

export interface RunOptions {
  prompt: string;
  /** A git repository root; a worktree is cut from here unless worktree=false. */
  cwd: string;
  /** Resume an existing agent session (Houston session_id continuity). */
  resumeSessionId?: string;
  host?: ExecutionHost;
  /** CLI binary; default "claude". */
  agentBin?: string;
  /** Cut an isolated git worktree for the run (default true). Ignored on a
   *  microVM host — the VM is itself the isolation boundary. */
  worktree?: boolean;
  /** Stable per-session key. When set, the worktree is `.genesis-runs/session-<key>`
   *  and REUSED across turns (not a fresh one per run) — required for `--resume`
   *  continuity on LocalHost, since claude sessions are cwd-scoped. The supervisor
   *  keeps such worktrees across turns (not removed per-turn). */
  sessionKey?: string;
  /** Working dir inside a microVM host (default: the sandbox default,
   *  /vercel/sandbox). Ignored on local/VPS hosts (they use cwd). */
  remoteCwd?: string;
  /** Extra CLI flags appended verbatim (e.g. --dangerously-skip-permissions). */
  extraArgs?: string[];
  /** Called on every projected state transition. */
  onState?: (state: RunState, event: AgentEvent) => void;
}

export interface RunResult {
  state: RunState;
  events: AgentEvent[];
  worktreePath?: string;
  branch?: string;
  /** True when the worktree is per-SESSION (sessionKey) — the caller must keep
   *  it across turns for `--resume` continuity, not remove it per-turn. */
  worktreePersistent?: boolean;
  exitCode: number;
}

function runId(): string {
  return `run-${Math.floor(performance.now()).toString(36)}-${process.pid.toString(36)}`;
}

async function isGitRepo(host: ExecutionHost, cwd: string): Promise<boolean> {
  const r = await host.exec(["git", "rev-parse", "--is-inside-work-tree"], { cwd });
  return r.code === 0 && r.stdout.trim() === "true";
}

/** Build the agent argv. `--verbose` is required to stream NDJSON under `-p`. */
function agentArgs(opts: RunOptions): string[] {
  const bin = opts.agentBin ?? "claude";
  const args = [bin, "-p", opts.prompt, "--output-format", "stream-json", "--verbose"];
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (opts.extraArgs) args.push(...opts.extraArgs);
  return args;
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const host = opts.host ?? new LocalHost();
  const id = runId();
  const isMicroVM = host.kind === "microvm";
  // microVM: the VM is the isolation boundary and the repo lives inside it, so
  // there is no local worktree and the cwd is a sandbox path (default
  // /vercel/sandbox). local/VPS: run at opts.cwd, in a cut worktree if enabled.
  let runCwd: string | undefined = isMicroVM ? opts.remoteCwd : opts.cwd;
  let worktreePath: string | undefined;
  let branch: string | undefined;
  // A sessionKey makes the worktree stable + reused across turns (resume needs a
  // consistent cwd); without it, a fresh per-run worktree (one-shot).
  const worktreePersistent = !!opts.sessionKey;

  const wantWorktree = opts.worktree !== false && !isMicroVM && (await isGitRepo(host, opts.cwd));
  if (wantWorktree) {
    const key = opts.sessionKey ? `session-${opts.sessionKey}` : id;
    branch = `genesis/${key}`;
    worktreePath = `${opts.cwd.replace(/\/$/, "")}/.genesis-runs/${key}`;
    // Reuse an existing session worktree (so claude --resume finds its cwd-scoped
    // session); otherwise create it. Attach a stale branch if the dir is gone.
    const list = await host.exec(["git", "worktree", "list", "--porcelain"], { cwd: opts.cwd });
    // Exact porcelain-line match (each block starts `worktree <abs-path>`), NOT a
    // substring — else session-1 would false-match an existing session-10.
    const exists = list.stdout.split("\n").some((l) => l === `worktree ${worktreePath}`);
    if (!exists) {
      let add = await host.exec(["git", "worktree", "add", "-b", branch, worktreePath, "HEAD"], {
        cwd: opts.cwd,
      });
      if (add.code !== 0) {
        // branch may already exist (prior session) → attach it instead of -b
        add = await host.exec(["git", "worktree", "add", worktreePath, branch], { cwd: opts.cwd });
        if (add.code !== 0) throw new Error(`worktree add failed: ${add.stderr}`);
      }
    }
    runCwd = worktreePath; // run IN the worktree (was incorrectly opts.cwd in Phase 1)
  }

  const handle = host.spawnStream(agentArgs(opts), { cwd: runCwd });
  const events: AgentEvent[] = [];
  let state = initialState;
  let exitCode = -1;
  try {
    for await (const line of handle.stdout) {
      const event = parseLine(line);
      if (!event) continue;
      events.push(event);
      state = reduce(state, event);
      opts.onState?.(state, event);
    }
    exitCode = await handle.exitCode;
  } catch (err) {
    // Mid-stream failure: kill the child (F14). Remove a per-run worktree (F13),
    // but KEEP a per-session one (a transient turn failure must not destroy the
    // session's resumable cwd).
    handle.kill();
    if (worktreePath && !worktreePersistent) {
      await removeWorktree(opts.cwd, worktreePath, branch, host).catch(() => {});
    }
    throw err;
  } finally {
    handle.kill(); // idempotent; reaps the child on every exit path (F14)
  }

  // A crash with no terminal result must surface as blocked, not a stuck "running" (F20).
  if (
    state.phase !== "done" &&
    state.phase !== "blocked" &&
    state.phase !== "awaiting" &&
    exitCode !== 0
  ) {
    state = { ...state, phase: "blocked", error: `agent exited ${exitCode}` };
  }
  return { state, events, worktreePath, branch, worktreePersistent, exitCode };
}

/** Remove a run's worktree AND its branch. Phase 1 discards both; merge-back
 *  (Phase 2) will use a distinct promote path before removal. */
export async function removeWorktree(
  cwd: string,
  worktreePath: string,
  branch?: string,
  host: ExecutionHost = new LocalHost(),
): Promise<void> {
  await host.exec(["git", "worktree", "remove", "--force", worktreePath], { cwd });
  if (branch) await host.exec(["git", "branch", "-D", branch], { cwd });
}

/** @deprecated use removeWorktree (which also deletes the leaked branch). */
export const cleanupWorktree = removeWorktree;
