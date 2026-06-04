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
  /** Cut an isolated git worktree for the run (default true). */
  worktree?: boolean;
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
  const runCwd = opts.cwd;
  let worktreePath: string | undefined;
  let branch: string | undefined;

  const wantWorktree = opts.worktree !== false && (await isGitRepo(host, opts.cwd));
  if (wantWorktree) {
    branch = `genesis/${id}`;
    worktreePath = `${opts.cwd.replace(/\/$/, "")}/.genesis-runs/${id}`;
    const add = await host.exec(["git", "worktree", "add", "-b", branch, worktreePath, "HEAD"], {
      cwd: opts.cwd,
    });
    if (add.code !== 0) throw new Error(`worktree add failed: ${add.stderr}`);
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
    // Mid-stream failure: never leak a worktree/branch (F13). Kill the child (F14).
    handle.kill();
    if (worktreePath) await removeWorktree(opts.cwd, worktreePath, branch, host).catch(() => {});
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
  return { state, events, worktreePath, branch, exitCode };
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
