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
  let runCwd = opts.cwd;
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
    runCwd = worktreePath;
  }

  const handle = host.spawnStream(agentArgs(opts), { cwd: runCwd });
  const events: AgentEvent[] = [];
  let state = initialState;
  for await (const line of handle.stdout) {
    const event = parseLine(line);
    if (!event) continue;
    events.push(event);
    state = reduce(state, event);
    opts.onState?.(state, event);
  }
  const exitCode = await handle.exitCode;
  return { state, events, worktreePath, branch, exitCode };
}

/** Remove a run's worktree (keep the branch for merge-back). */
export async function cleanupWorktree(
  cwd: string,
  worktreePath: string,
  host: ExecutionHost = new LocalHost(),
): Promise<void> {
  await host.exec(["git", "worktree", "remove", "--force", worktreePath], { cwd });
}
