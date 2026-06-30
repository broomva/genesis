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

/** Claude's native `--effort` flag enum (BRO-1573). Thinking only meaningfully
 *  engages at xhigh/max under subscription auth; there is no "off" level. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export interface RunOptions {
  prompt: string;
  /** A git repository root; a worktree is cut from here unless worktree=false. */
  cwd: string;
  /** Resume an existing agent session (Houston session_id continuity). */
  resumeSessionId?: string;
  host?: ExecutionHost;
  /** CLI binary; default "claude". */
  agentBin?: string;
  /** Per-turn model override → `--model <name>` (claude alias or full id).
   *  Omitted → the engine default (claude-opus-4-8[1m]). */
  model?: string;
  /** Per-turn extended-thinking effort → `--effort <level>` (BRO-1573). */
  effort?: EffortLevel;
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

/**
 * Build the env the spawned agent inherits — the host env MINUS Genesis's own
 * operational secrets (BRO-1527 #1). The agent runs untrusted prompts on the
 * real workspace; without this it inherits `process.env` wholesale and a
 * prompt-injected turn could exfiltrate the bot token, the owner allowlist, and
 * internal config. We strip:
 *   - the exact bot secret (`TELEGRAM_BOT_TOKEN`) + genesis-internal handles;
 *   - everything under `GENESIS_` (allowlist, data dirs, engine flags — config
 *     read by the host, never by the agent);
 *   - credential-shaped keys (`*_TOKEN|_KEY|_SECRET|_PASSWORD|_PASSWD|
 *     _CREDENTIAL[S]`, e.g. `ANTHROPIC_API_KEY`).
 * PATH / HOME / locale survive, so `claude` (subscription auth via ~/.claude)
 * and ordinary tasks still work. Per-task credential brokering (giving the agent
 * a specific secret on purpose, eve-style egress injection) is BRO-1527 #2/#3.
 */
export function scrubAgentEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const DENY_EXACT = new Set(["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME"]);
  const DENY_PREFIX = ["GENESIS_"];
  const DENY_PATTERN = /(_TOKEN|_KEY|_SECRET|_PASSWORD|_PASSWD|_CREDENTIAL)S?$/i;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (DENY_EXACT.has(k)) continue;
    if (DENY_PREFIX.some((p) => k.startsWith(p))) continue;
    if (DENY_PATTERN.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Build the agent argv. `--verbose` is required to stream NDJSON under `-p`;
 *  `--include-partial-messages` emits token-level `stream_event` deltas so the
 *  chat streams progressively instead of landing in one block (BRO-1571). */
function agentArgs(opts: RunOptions): string[] {
  const bin = opts.agentBin ?? "claude";
  const args = [
    bin,
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
  ];
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (opts.extraArgs) args.push(...opts.extraArgs);
  // Always-on summarized extended thinking (BRO-1614), pushed AFTER extraArgs so
  // the "always-on" guarantee can't be silently disabled by an operator-supplied
  // --thinking* in extraArgs (claude is last-wins; CodeRabbit + P20). Opus 4.8 /
  // Fable 5 default `thinking.display` to "omitted" (empty thinking prose); these
  // two HIDDEN flags (absent from `--help`) opt back into the summarized trace,
  // which the projection surfaces as reasoning parts (BRO-1608). Adaptive thinking
  // is content-dependent — trivial turns produce none, by design. A/B-verified:
  // with flags 240-289 chars, baseline 0 (claude 2.1.191 VPS / 2.1.196 local).
  args.push("--thinking", "adaptive", "--thinking-display", "summarized");
  // Per-turn knobs LAST so they override any constructor-level extraArgs default
  // (claude takes the last --model / --effort on the line). EQUALS-FORM
  // (`--model=<v>`) so the value can never be parsed as a separate flag even if a
  // caller smuggled a dash-prefixed string past validation — defense-in-depth on
  // top of the parseChatRequest allowlist (P20 BRO-1573). Verified claude accepts
  // both `--model=haiku` and `--effort=max`.
  if (opts.model) args.push(`--model=${opts.model}`);
  if (opts.effort) args.push(`--effort=${opts.effort}`);
  return args;
}

/**
 * Ensure the keyed session worktree exists (reused across turns) and return
 * its path + branch. Shared by the print (`runAgent`) and interactive
 * (`createInteractiveEngine`) engines — extracted verbatim from `runAgent`.
 */
export async function ensureSessionWorktree(
  host: ExecutionHost,
  cwd: string,
  key: string,
): Promise<{ worktreePath: string; branch: string }> {
  const branch = `genesis/${key}`;
  // Build the path from git's CANONICAL repo root, not cwd verbatim:
  // `git worktree list --porcelain` reports symlink-resolved paths, so a cwd
  // like /tmp (→ /private/tmp on macOS) or a bind-mounted root would otherwise
  // never exact-match an existing worktree → every resumed turn would re-add
  // and throw. Canonicalizing both sides fixes it.
  const top = await host.exec(["git", "rev-parse", "--show-toplevel"], { cwd });
  const root = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : cwd.replace(/\/$/, "");
  const worktreePath = `${root}/.genesis-runs/${key}`;
  // Reuse an existing session worktree (so the agent's cwd-scoped session
  // continuity holds); otherwise create it. Attach a stale branch if the dir
  // is gone.
  const list = await host.exec(["git", "worktree", "list", "--porcelain"], { cwd });
  // Exact porcelain-line match (each block starts `worktree <abs-path>`), NOT a
  // substring — else session-1 would false-match an existing session-10.
  const exists = list.stdout.split("\n").some((l) => l === `worktree ${worktreePath}`);
  if (!exists) {
    let add = await host.exec(["git", "worktree", "add", "-b", branch, worktreePath, "HEAD"], {
      cwd,
    });
    if (add.code !== 0) {
      // branch may already exist (prior session) → attach it instead of -b
      add = await host.exec(["git", "worktree", "add", worktreePath, branch], { cwd });
      if (add.code !== 0) throw new Error(`worktree add failed: ${add.stderr}`);
    }
  }
  return { worktreePath, branch };
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
  // consistent cwd); without it, a fresh per-run worktree (one-shot). microVM
  // skips worktrees entirely, so it is never persistent in that sense.
  const worktreePersistent = !!opts.sessionKey && !isMicroVM;

  const wantWorktree = opts.worktree !== false && !isMicroVM && (await isGitRepo(host, opts.cwd));
  if (wantWorktree) {
    const key = opts.sessionKey ? `session-${opts.sessionKey}` : id;
    ({ worktreePath, branch } = await ensureSessionWorktree(host, opts.cwd, key));
    runCwd = worktreePath; // run IN the worktree (was incorrectly opts.cwd in Phase 1)
  }

  // Scrub Genesis's own secrets from the agent's env (BRO-1527 #1): the agent
  // runs untrusted prompts, so it must not inherit the bot token / allowlist /
  // internal config. replaceEnv = the agent gets EXACTLY this env, not a merge.
  const handle = host.spawnStream(agentArgs(opts), {
    cwd: runCwd,
    env: scrubAgentEnv(),
    replaceEnv: true,
  });
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

// Interactive (exempt) engine — persistent interactive sessions via
// @genesis/session-host. See ./interactive.ts (BRO-1488).
export {
  createInteractiveEngine,
  type EngineHub,
  type EngineSession,
  type InteractiveEngine,
  type InteractiveEngineConfig,
} from "./interactive";

// Slash-command interception for the interactive engine (BRO-1485 #10).
export { interceptSlashCommand, TUI_BUILTIN_COMMANDS } from "./slash";

// Session observability (BRO-1519) — re-exported so the api wires the logger
// without a direct @genesis/session-host dependency.
export { RunLogger, type RunLoggerOptions, type IREvent } from "@genesis/session-host";
