// Codex engine (BRO-1621) — drives OpenAI's `codex` CLI as a Genesis runner,
// the second agentic harness behind the same Supervisor seam as claude.
//
// The whole point of the engine registry (BRO-1620) is that a `RunnerFn` is the
// ONLY contract a harness must satisfy: take a prompt + cwd, stream work, return
// a folded `RunState`. claude (`runAgent`) and codex (`runCodex`) are siblings —
// same worktree isolation, same env-scrub, same projection reducer. They differ
// in exactly two places, both isolated here:
//   1. the argv (`codexArgs`)            — `codex exec --json` vs `claude -p`.
//   2. the line shape (`parseCodexLine`) — codex emits a thread/turn/item JSONL
//      taxonomy, NOT claude's system/assistant/result stream-json. We translate
//      each codex line into the SAME `AgentEvent[]` the reducer already folds,
//      so the entire projection/render/persist pipeline below the parser is
//      reused verbatim and stays 100% engine-agnostic.
//
// Auth is ChatGPT-subscription, file-based (`~/.codex/auth.json`, auth_mode
// "chatgpt") — exactly how we drive claude by subscription, no API key. The
// user runs `codex login --device-auth` ON the host once; the agent NEVER logs
// in. `codexEnv` keeps HOME/CODEX_HOME so that auth survives, and deliberately
// strips OPENAI_API_KEY so codex can't silently fall back to metered API auth.
//
// Isolation, stated precisely (the env-scrub is NOT the whole story): the scrub
// removes env-VAR secrets, but under the `-s workspace-write` sandbox the agent
// can still READ the entire filesystem (only writes are confined to the
// workspace) — so file-based secrets (`~/.codex/auth.json`, `~/.ssh/…`) are
// readable by a prompt-injected turn. The two guards that actually hold are:
// (1) `codexArgs` pins `network_access=false`, so a read can't be exfiltrated
// over the network by a model-run command; (2) `approval_policy=never` denies
// (never escalates) anything the sandbox blocks. NOTE: per-run git-worktree
// isolation applies only when the deploy does NOT set `GENESIS_NO_WORKTREE=1`;
// prod sets it (nested-repo workspaces), so there codex runs in the real
// workspace tree — the network pin + write-confinement are the live boundary.

import { type ExecutionHost, LocalHost } from "@genesis/host";
import {
  type AgentEvent,
  type ContentBlock,
  type RawUsage,
  type RunState,
  initialState,
  reconcileStrandedParts,
  reduce,
} from "@genesis/projection";
import {
  CODEX_EFFORT_LEVELS,
  type RunOptions,
  type RunResult,
  ensureSessionWorktree,
  isCodexModel,
  isGitRepo,
  removeWorktree,
  scrubAgentEnv,
} from "./index";

function codexRunId(): string {
  return `codex-${Math.floor(performance.now()).toString(36)}-${process.pid.toString(36)}`;
}

/**
 * Build the `codex exec` argv. Two distinct shapes — a NEW thread vs RESUME of
 * an existing one — because `codex exec` takes no approval-policy flag and the
 * `resume` sub-command takes no `-s/--sandbox`; both knobs go through `-c
 * key=value` config overrides where a flag isn't available. Verified against
 * codex-cli 0.133.0 (`codex exec --help` / `codex exec resume --help`):
 *   - `exec` has -s/--sandbox + --skip-git-repo-check + --json, but NO -a flag
 *     (approval policy is config-only) — `-a never` is an exit-2 usage error.
 *   - `resume <id>` has --json + --skip-git-repo-check + -c, but NO -s flag.
 *
 *   new    : codex exec --json --skip-git-repo-check -s workspace-write -c approval_policy=never -c sandbox_workspace_write.network_access=false -- <prompt>
 *   resume : codex exec resume <id> --json --skip-git-repo-check -c sandbox_mode=workspace-write -c approval_policy=never -c sandbox_workspace_write.network_access=false -- <prompt>
 *
 * The prompt is a positional after `--` so a prompt starting with `-` can never
 * be parsed as a flag (defense-in-depth, mirrors claude's equals-form). The cwd
 * is NOT passed as `-C`; codex inherits it from the spawned process (we set
 * `spawnStream({ cwd })`), which keeps new + resume identical AND lines up with
 * codex's cwd-scoped session filtering so `resume <id>` finds the thread.
 * `--json` emits the thread/turn/item JSONL we parse.
 *
 * `network_access=false` is pinned (not left to codex's default / the user's
 * `~/.codex/config.toml`) as defense-in-depth: under `workspace-write` the agent
 * can READ the whole filesystem (only writes are confined), so a prompt-injected
 * turn could otherwise exfiltrate file-based secrets over the network. This pins
 * the sandbox shut for model-RUN commands; codex's own API call to OpenAI is
 * unaffected (it runs outside the command sandbox). P20 BRO-1621.
 *
 * `opts.extraArgs` is intentionally NOT forwarded — `extraArgs` is the
 * supervisor's `GENESIS_AGENT_ARGS`, canonically claude flags
 * (`--dangerously-skip-permissions`); codex's clap parser rejects an unknown
 * flag with exit 2, which would brick EVERY codex turn on any host configured
 * for claude. The engine boundary must not leak the other vendor's global knobs
 * (P20 BRO-1621, Forge cross-vendor finding).
 *
 * `opts.model` / `opts.effort` ARE forwarded provider-correctly (BRO-1623): the
 * UI now sends OpenAI values for codex (a model via `-m`, reasoning effort via
 * `-c model_reasoning_effort=<level>`), so per-turn control works like print.
 * Both are omitted when unset → codex falls back to its `~/.codex/config.toml`
 * defaults (e.g. gpt-5.5). An auth-tier-gated model still 400s, but the picker
 * only offers models the subscription supports, and a 400 maps to a blocked
 * turn via parseCodexLine (graceful). model/effort go BEFORE `--` (flags), and
 * the model rides `-m <value>` as a separate argv element (no shell; the value
 * is allowlist-validated upstream in parseChatRequest).
 */
function codexModelEffortArgs(opts: RunOptions): string[] {
  const extra: string[] = [];
  // Vendor-boundary drop (BRO-1623, P20): only OpenAI-shaped models + codex
  // reasoning levels reach codex's flags; a claude alias (sticky-engine
  // divergence / raw curl) is dropped → codex's config default, never `-m opus`.
  if (opts.model && isCodexModel(opts.model)) extra.push("-m", opts.model);
  if (opts.effort && (CODEX_EFFORT_LEVELS as readonly string[]).includes(opts.effort)) {
    extra.push("-c", `model_reasoning_effort=${opts.effort}`);
  }
  return extra;
}

export function codexArgs(opts: RunOptions): string[] {
  const bin = opts.agentBin ?? "codex";
  if (opts.resumeSessionId) {
    return [
      bin,
      "exec",
      "resume",
      opts.resumeSessionId,
      "--json",
      "--skip-git-repo-check",
      "-c",
      "sandbox_mode=workspace-write",
      "-c",
      "approval_policy=never",
      "-c",
      "sandbox_workspace_write.network_access=false",
      ...codexModelEffortArgs(opts),
      "--",
      opts.prompt,
    ];
  }
  return [
    bin,
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-s",
    "workspace-write",
    "-c",
    "approval_policy=never",
    "-c",
    "sandbox_workspace_write.network_access=false",
    ...codexModelEffortArgs(opts),
    "--",
    opts.prompt,
  ];
}

/**
 * The env codex inherits — Genesis secrets stripped (BRO-1527 #1), same policy
 * as claude (`scrubAgentEnv`). Two codex-specific consequences worth naming:
 *   - HOME / CODEX_HOME survive (neither matches a deny rule), so the
 *     subscription auth at `~/.codex/auth.json` (or $CODEX_HOME) is found —
 *     this is what lets us drive codex by ChatGPT login, no API key.
 *   - OPENAI_API_KEY is stripped by the `*_KEY` deny pattern. That is the
 *     DESIRED behavior: it forces subscription auth and prevents a silent
 *     fall-through to metered API billing (and prevents a prompt-injected turn
 *     from exfiltrating the key).
 */
export function codexEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return scrubAgentEnv(base);
}

// ── codex JSONL → Genesis AgentEvent[] translation ──────────────────────────
// codex `exec --json` emits one JSON object per line with a top-level `type`:
//   thread.started {thread_id}        — session id, capture for --resume
//   turn.started / turn.completed     — turn boundary (completed carries usage)
//   turn.failed / error               — failure
//   item.started / item.completed     — a unit of work; item.type is one of
//     agent_message {text}            — assistant prose
//     reasoning {text|summary}        — extended thinking
//     command_execution {command, aggregated_output, exit_code}
//     (file_change | mcp_tool_call | web_search | …) — other tool-ish work
//
// We map each to the AgentEvent shapes the reducer folds (see reducer.ts):
//   thread.started   → system (+ session_id)
//   agent_message    → assistant{ content:[text] }      → lastText + parts
//   reasoning        → assistant{ content:[thinking] }  → reasoned + reasoning
//   command_exec     → assistant{ tool_use } + user{ tool_result } (id-joined)
//   other item       → generic assistant{ tool_use } + user{ tool_result }
//   turn.completed   → result{ subtype:"success", usage }
//   turn.failed/err  → result{ is_error:true }
// A single codex line can yield MULTIPLE Genesis events (a completed command is
// both a tool_use AND its tool_result), hence the array return — runCodex folds
// each through `reduce` in order, exactly like claude's one-event-per-line loop.

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  summary?: unknown;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  [k: string]: unknown;
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

/** Map codex usage → Genesis RawUsage. codex `input_tokens` is the TOTAL prompt
 *  (cached + uncached); Genesis `input_tokens` excludes cache (the context meter
 *  sums input + cacheRead + cacheCreation), so subtract the cached portion to
 *  avoid double-counting. codex has no cache-creation split → 0. `reasoning_
 *  output_tokens` is reported separately and intentionally NOT folded into
 *  `output_tokens`: the context-window meter sums the PROMPT side (input + cache)
 *  only, so reasoning tokens don't affect it, and codex turns are unpriced
 *  (costUsd stays undefined) so there's no billing line they'd skew. */
function mapCodexUsage(u: CodexUsage | undefined): RawUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const total = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const cached = typeof u.cached_input_tokens === "number" ? u.cached_input_tokens : 0;
  return {
    input_tokens: Math.max(0, total - cached),
    output_tokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

/** Best-effort reasoning prose from a codex `reasoning` item — `text`, else a
 *  joined `summary` (string or array of {text}/strings), else "". The reducer
 *  marks `reasoned:true` from the presence of the thinking block regardless, so
 *  an empty string still lights the indicator (subscription summaries may be
 *  redacted, exactly like claude under OAuth). */
function reasoningText(item: CodexItem): string {
  if (typeof item.text === "string") return item.text;
  const s = item.summary;
  if (typeof s === "string") return s;
  if (Array.isArray(s)) {
    return s
      .map((p) =>
        typeof p === "string"
          ? p
          : p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
            ? (p as { text: string }).text
            : "",
      )
      .join("");
  }
  return "";
}

/** A compact, capped string view of an unknown codex item for a generic tool
 *  result body (file_change / mcp_tool_call / web_search / …). */
function genericSummary(item: CodexItem): string {
  try {
    const s = JSON.stringify(item);
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
  } catch {
    return String(item.type ?? "item");
  }
}

/** Extract a short error message from a codex `turn.failed` / `error` line. */
function errorMessage(value: Record<string, unknown>): string {
  const e = value.error ?? value.message;
  if (typeof e === "string") return e.slice(0, 200);
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message.slice(0, 200);
  }
  return "error";
}

const asstText = (text: string): AgentEvent => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const asstThinking = (thinking: string): AgentEvent => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "thinking", thinking }] },
});
const asstToolUse = (id: string, name: string, input: unknown): AgentEvent => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});
const userToolResult = (id: string, content: unknown, isError: boolean): AgentEvent => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError } as ContentBlock],
  },
});

/**
 * Translate ONE codex `exec --json` line into the ordered Genesis events it
 * implies. Tolerant by construction: blank lines, malformed JSON, and any
 * unrecognized `type` / `item.type` yield `[]` (codex emits diagnostic and
 * forward-incompatible lines we must skip without breaking the fold).
 */
export function parseCodexLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];
  let value: { type?: unknown; [k: string]: unknown };
  try {
    value = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (typeof value !== "object" || value === null) return [];
  const type = typeof value.type === "string" ? value.type : "";

  switch (type) {
    case "thread.started": {
      const sid = typeof value.thread_id === "string" ? value.thread_id : undefined;
      return [{ type: "system", subtype: "init", session_id: sid }];
    }
    case "turn.started":
      return [];
    case "turn.completed":
      // → a SUCCESS `result`, which the reducer treats as the absorbing terminal.
      // Safe because `codex exec` is single-turn-per-invocation (verified live on
      // 0.133.0: exactly one turn.started→turn.completed, then the process exits);
      // the happy path NEEDS this to terminalize, since runCodex's post-loop only
      // forces `blocked` on a NONZERO exit, so a clean zero-exit run would
      // otherwise stay "running". The deliberate omission of a `result` field
      // preserves the agent_message text as `lastText` (reducer: `event.result ??
      // state.lastText`) — do NOT add one here or the final answer is clobbered.
      // INVARIANT: if a future codex emits >1 turn per exec, this absorbs-drops
      // everything after the first turn.completed → terminalize on process-exit
      // instead (P20 BRO-1621, Forge finding).
      return [
        { type: "result", subtype: "success", usage: mapCodexUsage(value.usage as CodexUsage) },
      ];
    case "turn.failed":
    case "error":
    case "thread.error":
      return [{ type: "result", is_error: true, subtype: errorMessage(value) }];
    case "item.started":
    case "item.completed": {
      const item = (value.item ?? {}) as CodexItem;
      const itemType = typeof item.type === "string" ? item.type : "";
      const id = typeof item.id === "string" ? item.id : undefined;
      const completed = type === "item.completed";

      if (itemType === "agent_message") {
        // Only the completed message carries the final text; ignore the start.
        return completed && typeof item.text === "string" ? [asstText(item.text)] : [];
      }
      if (itemType === "reasoning") {
        return completed ? [asstThinking(reasoningText(item))] : [];
      }
      if (itemType === "command_execution") {
        if (!id) return [];
        const toolUse = asstToolUse(id, "shell", { command: item.command ?? "" });
        if (!completed) return [toolUse]; // started → input-available tool part
        // completed → re-emit the tool_use (idempotent in the reducer, so a
        // dropped `item.started` can't strand the result) + fill its output.
        // Success requires an EXPLICIT zero exit: a completed command with a
        // null/absent exit_code (killed / timed-out / unknown) is an error, not
        // a silent green (P20 BRO-1621). NOTE: each codex item maps to its own
        // assistant event, so RunState.turns counts items, not API turns — this
        // is latent (turns isn't surfaced in DispatchResult/persistence) but
        // means codex `turns` ≠ claude `turns`; don't compare them.
        const isError = !(typeof item.exit_code === "number" && item.exit_code === 0);
        return [toolUse, userToolResult(id, item.aggregated_output ?? "", isError)];
      }
      // Any OTHER item type (file_change, mcp_tool_call, web_search, todo_list,
      // …): surface it as a generic tool part on completion so the work is
      // visible in the timeline without a per-type schema. Needs an id to join.
      // The tool_use INPUT is just the type (not the whole item) so an item that
      // embeds large bodies — e.g. a file_change with file contents — can't push
      // an uncapped blob into the persisted timeline; the (capped) detail rides
      // the result body instead (P20 BRO-1621, Forge finding).
      if (completed && id) {
        return [
          asstToolUse(id, itemType || "item", { type: itemType || "item" }),
          userToolResult(id, genericSummary(item), false),
        ];
      }
      return [];
    }
    default:
      return [];
  }
}

/** Parse a whole codex `exec --json` blob into the ordered Genesis event list. */
export function parseCodexStream(blob: string): AgentEvent[] {
  return blob.split("\n").flatMap(parseCodexLine);
}

/**
 * Run a turn through the codex CLI — the codex `RunnerFn`. Structurally a clone
 * of `runAgent` (worktree isolation, scrubbed env, fold-stream-into-RunState,
 * F13/F14/F20 cleanup), differing only in argv (`codexArgs`), env (`codexEnv`),
 * and the per-line parser (`parseCodexLine`, which yields an array). The
 * resumeSessionId is seeded into the initial state so `state.sessionId` is the
 * codex thread id even if a resumed turn doesn't re-emit `thread.started`.
 */
export async function runCodex(opts: RunOptions): Promise<RunResult> {
  const host = opts.host ?? new LocalHost();
  const id = codexRunId();
  const isMicroVM = host.kind === "microvm";
  let runCwd: string | undefined = isMicroVM ? opts.remoteCwd : opts.cwd;
  let worktreePath: string | undefined;
  let branch: string | undefined;
  const worktreePersistent = !!opts.sessionKey && !isMicroVM;

  const wantWorktree = opts.worktree !== false && !isMicroVM && (await isGitRepo(host, opts.cwd));
  if (wantWorktree) {
    const key = opts.sessionKey ? `session-${opts.sessionKey}` : id;
    ({ worktreePath, branch } = await ensureSessionWorktree(host, opts.cwd, key));
    runCwd = worktreePath;
  }

  const handle = host.spawnStream(codexArgs(opts), {
    cwd: runCwd,
    env: codexEnv(),
    replaceEnv: true,
  });
  const events: AgentEvent[] = [];
  // Seed the session id from the resume target: a resumed codex turn may not
  // re-emit thread.started, but the supervisor still needs the id persisted.
  let state: RunState = opts.resumeSessionId
    ? { ...initialState, sessionId: opts.resumeSessionId }
    : initialState;
  let exitCode = -1;
  try {
    for await (const line of handle.stdout) {
      for (const event of parseCodexLine(line)) {
        events.push(event);
        state = reduce(state, event);
        opts.onState?.(state, event);
      }
    }
    exitCode = await handle.exitCode;
  } catch (err) {
    handle.kill();
    if (worktreePath && !worktreePersistent) {
      await removeWorktree(opts.cwd, worktreePath, branch, host).catch(() => {});
    }
    throw err;
  } finally {
    handle.kill();
  }

  if (state.phase !== "done" && state.phase !== "blocked" && state.phase !== "awaiting") {
    // The process is gone but the run never terminalized. This covers BOTH a
    // nonzero exit AND a clean exit-0 that emitted no PARSED terminal — codex
    // can stop with status 0 while parseCodexLine dropped every line (unknown/
    // malformed), which would otherwise leave the run stuck "running" downstream
    // (CodeRabbit). Force-block either way + reconcile any tool the truncated
    // stream left "running" so the UI doesn't spin forever.
    state = {
      ...state,
      phase: "blocked",
      error: exitCode === 0 ? "codex ended without a result" : `codex exited ${exitCode}`,
      parts: reconcileStrandedParts(state.parts),
    };
  }
  return { state, events, worktreePath, branch, worktreePersistent, exitCode };
}
