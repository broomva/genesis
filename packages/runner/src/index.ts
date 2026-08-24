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
import { resolveClaudeBinary } from "@genesis/session-host";

/** Reasoning-effort levels across engines (BRO-1573/1623). The union spans both
 *  providers; the per-provider arrays below gate which reach which engine —
 *  `xhigh`/`max` are claude-only (codex rejects them). */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** Claude's native `--effort` flag enum (BRO-1573) — print + interactive. Thinking
 *  only meaningfully engages at xhigh/max under subscription auth; no "off" level. */
export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** codex `-c model_reasoning_effort=<level>` values (BRO-1623). VERIFIED against
 *  gpt-5.5 on the live CLI 0.142.4: low/medium/high are accepted; `minimal` is
 *  REJECTED ("error: invalid") despite being a generic OpenAI reasoning level, so
 *  it is NOT offered (benchmark-the-real-engine). codex has no xhigh/max. */
export const CODEX_EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high"];

// ── Provider model/effort guards (BRO-1623, P20 Forge MUST-FIX) ─────────────
// Engine binding is STICKY (BRO-1620): the request's engine is advisory after a
// thread's first turn, so a later request can carry an effort/model meant for a
// DIFFERENT provider than the one that actually runs. The UI clamps to the bound
// engine, but the server is a standalone channel ("any useChat client or curl"),
// so the vendor boundary — the runner that builds the argv — is where we drop an
// out-of-provider value, robustly for every caller regardless of how the
// supervisor resolved the engine. A dropped value → the engine's own default.

const CLAUDE_MODEL_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);

/** A model claude's `--model` accepts: an alias (opus/sonnet/haiku/fable) or a
 *  full `claude-*` id. An OpenAI id (gpt-*, o3, …) is rejected so it can't reach
 *  the claude runner. */
export function isClaudeModel(model: string): boolean {
  return CLAUDE_MODEL_ALIASES.has(model) || model.startsWith("claude");
}

/** A model codex's `-m` accepts: an OpenAI id (gpt-*, o<n>, codex-*). A claude
 *  alias is rejected so it can't reach the codex runner (where it would 400). */
export function isCodexModel(model: string): boolean {
  return /^(gpt|o\d|codex)/i.test(model);
}

/** A file the user attached to a turn (BRO-1706). Materialized into the agent's
 *  working directory before the run so the CLI's native multimodal `Read` tool can
 *  operate on it (images, PDFs, notebooks, any text). Carries the bytes as a
 *  `data:` URL (base64) — the same shape the AI SDK `FileUIPart` rides on the wire. */
export interface RunAttachment {
  /** Original client file name (sanitized to a safe basename on disk). */
  filename: string;
  /** MIME type (advisory — surfaced in the prompt manifest). */
  mediaType?: string;
  /** A `data:<mediaType>;base64,<bytes>` URL carrying the file content. */
  url: string;
}

export interface RunOptions {
  prompt: string;
  /** A git repository root; a worktree is cut from here unless worktree=false. */
  cwd: string;
  /** Resume an existing agent session (Houston session_id continuity). */
  resumeSessionId?: string;
  host?: ExecutionHost;
  /** CLI binary; default resolves via {@link resolveClaudeBinary} (explicit path
   *  wins). */
  agentBin?: string;
  /** Pin a specific Claude Code version (BRO-1642) — resolves to the absolute
   *  `~/.local/share/claude/versions/<pin>` if present (matching the interactive
   *  engine), else warns + falls back to PATH `claude`. Prevents a stale PATH CLI
   *  that rejects `--include-partial-messages`. Sourced from GENESIS_CLAUDE_PIN. */
  pin?: string;
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
  /** Per-tenant HOME (BRO-2235). Unset = the server's own HOME, i.e. current
   *  behaviour. When set to an ABSOLUTE path, the spawned agent reads its
   *  credential, settings and skills from there instead of the operator's home.
   *
   *  Threaded from `Workspace.home` by the supervisor. See {@link tenantEnv} for
   *  why an unset or relative value is ignored rather than refused. */
  home?: string;
  /** Extra CLI flags appended verbatim (e.g. --dangerously-skip-permissions). */
  extraArgs?: string[];
  /** Files the user attached to this turn (BRO-1706) — written into the run cwd
   *  under `.genesis/attachments/` before spawn; their absolute paths are appended
   *  to the prompt so the agent can Read them (images/PDFs supported natively). */
  attachments?: RunAttachment[];
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

export async function isGitRepo(host: ExecutionHost, cwd: string): Promise<boolean> {
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
  // + the two nested-Claude markers (BRO-1642): when genesis-api is itself launched
  // under a claude agent, an inherited CLAUDE_CODE_ENTRYPOINT/CLAUDECODE makes the
  // child `claude -p` detect it's nested and change behavior. Strip them so the
  // spawned agent is always a clean top-level session (Houston does the same).
  const DENY_EXACT = new Set([
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_BOT_USERNAME",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDECODE",
  ]);
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

/** BRO-2235 — per-tenant HOME, so a confined tenant stops inheriting the
 *  operator's `~/.claude`.
 *
 *  WHY THIS IS NOT ONLY ABOUT CREDENTIALS. Measured on srv1692698: with HOME
 *  defaulting to the operator's, a confined tenant inherits everything under
 *  `~/.claude` — 75 user-scope SKILLS (it listed 90 in total), the user-scope
 *  `settings.json` (`defaultMode: bypassPermissions`, `sandbox: false`), and shared
 *  `history.jsonl` / `projects/` / `sessions/`. Two of those skills declare
 *  `allowed-tools`, which the CLI installs as a real permission layer —
 *  `use-railway` grants `Bash(railway:*|npm:*|npx:*|curl:*|python3:*)` — and the
 *  tenant confirmed it is reachable. The tenant's PROJECT settings.json does not
 *  govern any of it, because user scope is a different precedence level entirely.
 *
 *  Pointing HOME at a per-tenant directory closes that whole class at once, and it
 *  is independent of WHICH credential the session uses: identity is unchanged until
 *  an operator decides the subscription-vs-API question.
 *
 *  FAIL-SAFE, NOT FAIL-CLOSED, and the difference is deliberate. `hardenedExtraArgs`
 *  can safely add a flag to every confined turn. This cannot safely *omit* HOME: a
 *  tenant whose home was never provisioned would get a session with no credential
 *  and every turn would fail. So an unset `home` leaves the environment untouched —
 *  the current behaviour — and the provisioner is what decides a tenant is ready.
 *  Refusing here would convert a provisioning gap into an outage.
 *
 *  Pure + exported so the invariant is covered by a test rather than by a comment. */
// OVERLOADED so the spawn site needs no fallback. Passing a base always yields a
// base, and expressing that in the type removed a `?? scrubAgentEnv()` that could
// never run — and that, if it ever had, would have handed the child an env with no
// PATH. A dead branch on the environment of a spawned agent is not worth keeping.
export function tenantEnv(
  workspace: { home?: string },
  base: Record<string, string>,
): Record<string, string>;
export function tenantEnv(
  workspace: { home?: string },
  base?: Record<string, string>,
): Record<string, string> | undefined;
export function tenantEnv(
  workspace: { home?: string },
  base?: Record<string, string>,
): Record<string, string> | undefined {
  const home = workspace.home?.trim();
  if (!home) return base;
  // ABSOLUTE only. A relative HOME resolves against the child's cwd — the tenant's
  // own workspace — which would silently place `.claude` inside the directory the
  // tenant can write, handing it its own settings file.
  if (!home.startsWith("/")) return base;
  return { ...(base ?? {}), HOME: home };
}

/** Build the agent argv. `--verbose` is required to stream NDJSON under `-p`;
 *  `--include-partial-messages` emits token-level `stream_event` deltas so the
 *  chat streams progressively instead of landing in one block (BRO-1571). */
function agentArgs(opts: RunOptions, bin: string): string[] {
  // `bin` is resolved by the caller (BRO-1642: explicit agentBin > pinned > PATH).
  // The prompt is NOT on argv — it rides stdin (runAgent passes it as `input`), so a
  // large attachment-laden prompt can't exceed the OS argv cap. `claude -p` with no
  // positional prompt reads it from stdin.
  const args = [
    bin,
    "-p",
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
  // Vendor-boundary drop (BRO-1623, P20): only claude-shaped models + claude
  // effort levels reach claude's flags; a codex value (sticky-engine divergence
  // or a raw curl) is dropped → claude's default, never `--model=gpt-5.5`.
  if (opts.model && isClaudeModel(opts.model)) args.push(`--model=${opts.model}`);
  if (opts.effort && (EFFORT_LEVELS as readonly string[]).includes(opts.effort)) {
    args.push(`--effort=${opts.effort}`);
  }
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

/** Sanitize a client-supplied filename to a safe basename (BRO-1706, P20):
 *  strip any directory components (path-traversal guard — a `../../etc/x` name can
 *  never escape the attachments dir) and reduce to a conservative charset. */
export function safeAttachmentName(name: string, index: number): string {
  const base = (name.split(/[\\/]/).pop() ?? "").trim();
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "") // no leading dots → never a dotfile / "." / ".."
    .slice(0, 128);
  return cleaned || `file-${index + 1}`;
}

/** Decode a `data:<mime>[;params];base64,<data>` URL to its raw bytes, or null if
 *  it isn't a base64 data URL (blob:/http: never survive the wire hop — only data:
 *  does). Tolerates RFC-2397 mediatype parameters (e.g.
 *  `data:image/png;charset=utf-8;base64,…`) — matches up to the LAST `;base64,`
 *  delimiter, not just a param-less type (BRO-1706, P20 cross-review). */
export function decodeDataUrl(url: string): Uint8Array | null {
  const m = /^data:[^,]*;base64,(.*)$/s.exec(url);
  if (!m) return null; // require ;base64 — we never wrote a non-base64 URL
  try {
    return new Uint8Array(Buffer.from(m[1] ?? "", "base64"));
  } catch {
    return null;
  }
}

/** Materialize attachments into `<cwd>/.genesis/attachments/` and return a prompt
 *  manifest block listing their ABSOLUTE paths (the CLI `Read` tool requires
 *  absolute paths). Writes go through the host seam so this works on local/vps/
 *  microVM alike. Best-effort per file — a single bad attachment is skipped, not
 *  fatal to the turn. Returns "" when nothing was written. */
export async function materializeAttachments(
  host: ExecutionHost,
  cwd: string,
  attachments: RunAttachment[],
): Promise<string> {
  const dir = `${cwd.replace(/\/$/, "")}/.genesis/attachments`;
  await host.exec(["mkdir", "-p", dir]);
  const used = new Set<string>();
  const written: { path: string; mediaType?: string }[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (!att) continue;
    const bytes = decodeDataUrl(att.url);
    if (!bytes || bytes.length === 0) continue;
    // De-collide names while preserving the extension (foo.png → foo-1.png).
    let name = safeAttachmentName(att.filename, i);
    if (used.has(name)) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let n = 1;
      while (used.has(`${stem}-${n}${ext}`)) n++;
      name = `${stem}-${n}${ext}`;
    }
    used.add(name);
    const abs = `${dir}/${name}`;
    try {
      await host.writeFile(abs, bytes);
      written.push({ path: abs, mediaType: att.mediaType });
    } catch {
      // Skip a file that failed to write; the turn proceeds with the rest.
    }
  }
  // Feedback when some (or all) attachments couldn't be materialized (P20
  // cross-review): tell the agent so it can tell the user, instead of silently
  // dropping a file the user watched themselves attach.
  const skipped = attachments.length - written.length;
  if (written.length === 0) {
    return `\n\n(Note: ${attachments.length} attached file${
      attachments.length > 1 ? "s" : ""
    } could not be processed and ${attachments.length > 1 ? "were" : "was"} skipped — tell the user.)`;
  }
  const lines = written.map((w) => `- ${w.path}${w.mediaType ? ` (${w.mediaType})` : ""}`);
  const plural = written.length > 1 ? "s" : "";
  const skippedNote =
    skipped > 0
      ? `\n(Note: ${skipped} other attached file${skipped > 1 ? "s" : ""} could not be processed and ${skipped > 1 ? "were" : "was"} skipped — tell the user.)`
      : "";
  return `\n\n---\nAttached file${plural} (saved to this workspace — read with your file tools as needed; images and PDFs are supported natively):\n${lines.join("\n")}${skippedNote}`;
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

  const cwdIsRepo = !isMicroVM && (await isGitRepo(host, opts.cwd));
  const wantWorktree = opts.worktree !== false && cwdIsRepo;
  if (wantWorktree) {
    const key = opts.sessionKey ? `session-${opts.sessionKey}` : id;
    ({ worktreePath, branch } = await ensureSessionWorktree(host, opts.cwd, key));
    runCwd = worktreePath; // run IN the worktree (was incorrectly opts.cwd in Phase 1)
  } else if (cwdIsRepo && runCwd) {
    // Root run on a git repo (BRO-1664): surface the cwd's current branch so the
    // session header can show `<workspace> · <branch>`. Best-effort — a detached
    // HEAD (empty output) or a resolve failure just leaves branch undefined and the
    // header falls back to the run posture.
    const b = await host.exec(["git", "branch", "--show-current"], { cwd: runCwd });
    if (b.code === 0) branch = b.stdout.trim() || undefined;
  }

  // Scrub Genesis's own secrets from the agent's env (BRO-1527 #1): the agent
  // runs untrusted prompts, so it must not inherit the bot token / allowlist /
  // internal config. replaceEnv = the agent gets EXACTLY this env, not a merge.
  // Resolve the CLI binary once (BRO-1642): explicit agentBin > pinned version
  // (opts.pin or GENESIS_CLAUDE_PIN, matching the interactive engine) > PATH claude.
  // A stale PATH claude rejects --include-partial-messages and would kill the turn.
  // HOST-AWARE (CodeRabbit): resolveClaudeBinary checks THIS machine's filesystem,
  // so a pinned absolute path is only valid when the agent runs on THIS machine
  // (LocalHost). On VpsHost / microVM the binary lives on the remote/sandbox box —
  // pass the plain name (explicit agentBin still honored) and let the remote PATH
  // resolve it, never a local absolute path that doesn't exist there.
  const bin =
    host.kind === "local"
      ? resolveClaudeBinary(opts.pin ?? process.env.GENESIS_CLAUDE_PIN, opts.agentBin)
      : (opts.agentBin ?? "claude");

  // Multimodal input (BRO-1706): write attached files into the resolved run cwd and
  // append their absolute paths to the prompt so the agent's native `Read` can
  // operate on them. Done after cwd resolution (a worktree path only exists now) and
  // before spawn. Best-effort — a materialization failure never blocks the turn.
  let prompt = opts.prompt;
  // On a microVM with no explicit remoteCwd, the sandbox spawns at its own default
  // (/vercel/sandbox) — materialize there too so files land in the agent's cwd
  // instead of being silently dropped (P20 cross-review). Local/VPS always have cwd.
  const attachCwd = runCwd ?? (isMicroVM ? "/vercel/sandbox" : undefined);
  if (opts.attachments && opts.attachments.length > 0 && attachCwd) {
    try {
      prompt += await materializeAttachments(host, attachCwd, opts.attachments);
    } catch {
      // Non-fatal: run the turn with the original prompt (attachments just absent).
    }
  }

  const handle = host.spawnStream(agentArgs(opts, bin), {
    cwd: runCwd,
    // BRO-2235: per-tenant HOME. `scrubAgentEnv()` decides WHICH variables survive;
    // `tenantEnv` then overrides HOME for a tenant that has one. Order matters —
    // scrub first, so a tenant home can never be removed by a later deny rule.
    //
    // `replaceEnv` stays true: the child's environment is exactly this object. That
    // is why HOME must be layered onto the scrubbed base rather than passed alone —
    // passing `{ HOME }` by itself would drop PATH and the child would not resolve
    // its own binary.
    env: tenantEnv(opts, scrubAgentEnv()),
    replaceEnv: true,
    // The prompt rides stdin, not argv (BRO-1642) — keeps a large attachment-laden
    // prompt under the OS argv cap. The host closes stdin after writing (EOF).
    input: prompt,
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

// Codex engine (BRO-1621) — the second harness (OpenAI codex CLI), a RunnerFn
// sibling of runAgent behind the same Supervisor seam. See ./codex.ts.
export {
  codexArgs,
  codexEnv,
  parseCodexLine,
  parseCodexStream,
  runCodex,
} from "./codex";
