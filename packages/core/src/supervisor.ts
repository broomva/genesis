// Supervisor — the control plane. resolve(threadId) → Session, then
// dispatch(text) → run the agent → project NDJSON → record turns → reply.
// The runner is injected so the supervisor is unit-testable without a live CLI.
//
// Dispatches are serialized PER THREAD (F19): the default channel uses a
// constant thread id, so two near-simultaneous messages on one session would
// otherwise stomp each other's phase + agentSessionId (corrupting --resume).
// The store is async (Phase 2) so a durable Drizzle/Postgres backend can be
// swapped in behind the same Supervisor — sessions survive a restart.

import { existsSync } from "node:fs";
import {
  type ExecutionHost,
  type HostLease,
  type HostProvider,
  LocalHost,
  StaticHostProvider,
} from "@genesis/host";
import { type AgentEvent, type RunState, asksRaisedBy } from "@genesis/projection";
// BRO-2235: `tenantEnv` moved to @genesis/runner, beside `scrubAgentEnv` — the
// spawn it shapes lives there, and `core` cannot be imported from `runner` (the
// dependency runs core -> runner). Re-exported so the name keeps working.
export { tenantEnv } from "@genesis/runner";
import {
  type EffortLevel,
  type RunAttachment,
  type RunOptions,
  type RunResult,
  removeWorktree,
  runAgent,
} from "@genesis/runner";
import { seedAgentStack } from "./agent-stack";
import { type ConcurrencyLimits, TurnGate, TurnRejectedError, type TurnSlot } from "./concurrency";
import { InMemoryStore, type Store, isoNow, newId } from "./store";
import type { Session, TokenUsage, Turn, Workspace } from "./types";
import { InMemoryWorkspaceRepository, type WorkspaceRepository } from "./workspace-repository";

export type RunnerFn = (opts: RunOptions) => Promise<RunResult>;

/** Per-turn overrides supplied by the channel (BRO-1573) — model + effort chosen
 *  in the UI for THIS message. Override the constructor-level defaults; absent
 *  fields fall back to the engine default. */
export interface TurnOptions {
  model?: string;
  effort?: EffortLevel;
  /** Requested agent engine (BRO-1620) — honored only on a thread's FIRST turn
   *  (sticky binding); ignored after. Unknown/unavailable → the default engine. */
  engine?: string;
  /** Requested workspace (BRO-1627) — honored only at SESSION CREATION (a
   *  thread's first turn, when the session row is minted); ignored after.
   *  Unknown/unregistered → the default workspace. Sticky, mirrors `engine`.
   *  EXCEPTION: see `channelQualified`, which turns both of those leniencies off. */
  workspaceId?: string;
  /** BRO-2236 / BRO-2241 — this turn arrives from a PUBLIC CHANNEL (WhatsApp), where
   *  `workspaceId` names a tenant rather than expressing a human's preference.
   *
   *  The two leniencies above are correct for a human picking a workspace in the web
   *  UI and dangerous for a channel: "unregistered → default" hands an unknown tenant
   *  the broadest directory on the box, and "sticky, ignored after" pins a row minted
   *  before its channel had a confined workspace to whatever it was bound to then.
   *  Both were measured live, not theorised.
   *
   *  Set true and BOTH become refusals. The caller decides, because only the caller
   *  knows the request came off a channel — core cannot sniff it from the id without
   *  copying the `GENESIS_WHATSAPP_WORKSPACE_PREFIX` convention into a second place. */
  channelQualified?: boolean;
  /** Requested worktree posture (BRO-1656) — `true` = cut a per-session worktree,
   *  `false` = run at the workspace root. Honored only on a thread's FIRST turn
   *  (sticky), and only when the workspace ALLOWS a worktree (a nested-repo
   *  workspace with `noWorktree` stays root-only — worktrees break there). Mirrors
   *  `engine`/`workspaceId`. */
  worktree?: boolean;
  /** Files attached to this turn (BRO-1706) — forwarded to the runner, which
   *  materializes them into the run cwd so the agent can Read them (multimodal). */
  attachments?: RunAttachment[];
}

/** Live-session control surface (BRO-1493). The interactive engine implements
 *  it; the print engine has none (control ops return not-supported). Keyed by
 *  the Supervisor's per-session worktree key (`session.id`). */
export interface EngineControl {
  reset(sessionKey: string): Promise<boolean>;
  interrupt(sessionKey: string): Promise<boolean>;
  status(sessionKey: string): Promise<{ alive: boolean; sessionId?: string }>;
}

/** Result of a /control action. */
export interface ControlResult {
  ok: boolean;
  /** Why ok=false: no engine control surface, or no session for the thread. */
  reason?: "unsupported" | "no-session";
  phase?: RunState["phase"];
  alive?: boolean;
  sessionId?: string;
}

export interface SupervisorConfig {
  store?: Store;
  /** Default workspace every new thread binds to when none is requested (and the
   *  turn-1 fallback). Always present in the registry. */
  defaultWorkspace: Workspace;
  /** Additional selectable workspaces (BRO-1627) — the boot-discovered registry
   *  (GENESIS_PROJECTS_ROOT scan + GENESIS_WORKSPACES override). Used to SEED the
   *  repository when it's empty (env → seed, not source of truth — BRO-1629). A new
   *  thread can bind any registered workspace via TurnOptions.workspaceId; the
   *  binding is sticky at session create. */
  workspaces?: Workspace[];
  /** The workspace registry source (BRO-1629, Phase 2.5). Omit → an in-memory
   *  adapter seeded from `defaultWorkspace` + `workspaces` (the BRO-1627 behaviour).
   *  The FS adapter (manifest-in-git) makes the registry runtime-mutable. */
  workspaceRepository?: WorkspaceRepository;
  /** Resolves an ExecutionHost per session (e.g. a per-session microVM). When
   *  omitted, a StaticHostProvider wraps `host` (or a LocalHost). */
  hostProvider?: HostProvider;
  /** Shorthand for a single shared host (wrapped in a StaticHostProvider). */
  host?: ExecutionHost;
  run?: RunnerFn;
  /** Live-session control surface (interactive engine). Enables /control
   *  (reset/interrupt/status). Omit → those ops report "unsupported". */
  control?: EngineControl;
  /** Engine REGISTRY (BRO-1620) — per-thread engine selection. `runners` maps an
   *  engine id ("print" | "interactive") to its runner; `controls` maps the ids
   *  that have a live-session control surface; `defaultEngine` is the engine a
   *  thread inherits when the client doesn't request one. `print` (runAgent) is
   *  ALWAYS registered as a baseline. The legacy single `run`/`control` still work
   *  (keyed by `defaultEngine`). */
  runners?: Record<string, RunnerFn>;
  controls?: Record<string, EngineControl>;
  defaultEngine?: string;
  /** Auto-generate a semantic thread title after the first turn (BRO-1665) via a
   *  small `haiku` print call. Default OFF — the API boot enables it in production;
   *  keeping it off by default means tests (and any embedder) don't pay for an extra
   *  LLM call or see the title mutate under them unless they opt in. */
  generateTitles?: boolean;
  /** Per-event observability tap (BRO-1524): every AgentEvent of every turn,
   *  tagged with the session id. The boot wires this for ALL turns now that both
   *  engines coexist (BRO-1620) — interactive turns get both this AgentEvent trace
   *  (a distinct *.events.jsonl file) and the engine's richer IR observer. */
  trace?: (sessionId: string, event: AgentEvent) => void;
  /** Called once per ask when a turn transitions INTO `awaiting` (BRO-2413).
   *
   *  This is the ask log's producer. Until it existed `askLog.append` had zero
   *  non-test callers, so `asks.jsonl` stayed empty in every real deploy and
   *  GET /walkie/asks answered `{"asks":[]}` forever.
   *
   *  Structurally typed rather than importing `Ask` from apps/api: core cannot
   *  depend on an app, and the shape is the contract. Optional and side-channel,
   *  exactly like `trace` — a throwing producer must not fail the turn. */
  onAsk?: (ask: {
    id: string;
    sessionId: string;
    threadId: string;
    question: string;
    header?: string;
    options?: readonly { readonly label: string; readonly description?: string }[];
    multiSelect?: boolean;
    createdAt: string;
  }) => void;
  /** Extra agent CLI flags applied to every run (e.g. permission mode). */
  extraArgs?: string[];
  /** Working dir inside a microVM host (forwarded to the runner; ignored on
   *  local/VPS). Default: the sandbox default (/vercel/sandbox). A lease's own
   *  remoteCwd (from the provider) takes precedence. */
  remoteCwd?: string;
  /** Run the agent DIRECTLY in the workspace instead of a per-session worktree
   *  (BRO-1512). Required when the workspace has nested git repos (a worktree
   *  checks out only the outer repo's tracked files, missing the nested ones).
   *  Continuity then relies on the persistent live session, not the worktree. */
  noWorktree?: boolean;
  /** Does a workspace rootPath exist on disk? (BRO-1629 slice 4 / BRO-1630 RC3.)
   *  Default: `existsSync`. Injected in tests so fake rootPaths don't trip the
   *  vanished-workspace guard (which is enforced only for LOCAL hosts). */
  workspaceExists?: (rootPath: string) => boolean;
  /** Seed a newly registered workspace's `.claude/agents` with the bstack agent
   *  stack (BRO-2252). Default: {@link seedAgentStack}. Injected in tests so the
   *  call can be asserted without touching a real filesystem. */
  stackSeeder?: (rootPath: string) => void;
  /** Bound simultaneous turns per workspace and box-wide (BRO-2260). Omit → the
   *  pre-BRO-2260 behaviour: unbounded. Composes with, and does not replace, the
   *  cgroup limits BRO-2275 put on the genesis-api unit. */
  concurrency?: ConcurrencyLimits;
  /** Kill a turn after this long with no stream output (BRO-2260). */
  turnIdleTimeoutMs?: number;
  /** Kill a turn after this long in total (BRO-2260). */
  turnMaxMs?: number;
}

export interface DispatchResult {
  session: Session;
  reply: string;
  phase: RunState["phase"];
  /** Token usage + exact cost for this turn (BRO-1597), from the CLI's terminal
   *  result. Undefined if the engine/CLI didn't report them. */
  usage?: TokenUsage;
  costUsd?: number;
  /** Server-measured agent run time in ms (BRO-1610). */
  durationMs?: number;
}

/** One row of the thread-list UI (BRO-1567): enough to render + resume a thread
 *  without loading its full transcript. `lastText` is the most-recent turn's text
 *  (any role) for a drawer preview; undefined for a never-run thread. `title`
 *  (BRO-1592) is the auto-derived/renamed label; `archived` lets the drawer hide
 *  soft-archived threads. */
export interface ThreadSummary {
  threadId: string;
  phase: Session["phase"];
  createdAt: string;
  lastText?: string;
  title?: string;
  archived: boolean;
  /** The thread's bound engine (BRO-1620), so the client can gate per-turn
   *  controls (model/effort) on the THREAD's actual engine, not the global pref.
   *  Absent on a never-run thread (it inherits the pref until its first turn). */
  engine?: string;
  /** The thread's bound workspace (BRO-1627) — id + display name, so the drawer
   *  + header can show which repo the thread runs in. `workspaceName` is absent if
   *  the workspace was deconfigured since the thread bound it. */
  workspaceId?: string;
  workspaceName?: string;
  /** The thread's bound worktree posture (BRO-1656/1657) — `true` = runs at the
   *  workspace root, `false` = in a per-session worktree. Surfaced (like `engine`
   *  / `workspaceId`) so the client can reflect the thread's committed posture.
   *  Absent on a never-run thread (it inherits the workspace/global default until
   *  its first turn binds it). */
  noWorktree?: boolean;
  /** The git branch the session's cwd is on (BRO-1664) — for the header subtitle
   *  (`<workspace> · <branch>`). `genesis/<key>` for a worktree session, the repo's
   *  current branch for a root session. Absent on a never-run thread or a non-git cwd. */
  branch?: string;
}

/** First-user-turn → a short thread title (BRO-1592). First line, collapsed
 *  whitespace, ~6 words / 48 chars. Empty input → undefined (keep the preview). */
export function deriveTitle(text: string): string | undefined {
  const oneLine = text.trim().split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (!oneLine) return undefined;
  const words = oneLine.split(" ").slice(0, 6).join(" ");
  // Slice by code point, not UTF-16 code unit, so a 48-boundary inside an astral
  // char (emoji / CJK) can't leave a lone surrogate (renders as U+FFFD).
  const chars = [...words];
  return chars.length > 48 ? `${chars.slice(0, 48).join("").trimEnd()}…` : words;
}

/** The model used to GENERATE a semantic thread title (BRO-1665) — a small, fast one
 *  (haiku) via the print engine, independent of the thread's own engine. */
export const TITLE_MODEL = "haiku";

/** Bound the title-gen call (BRO-1665, P20) so a hung `claude -p` can't hold a host
 *  lease / dangle a promise. Generous — a haiku one-shot completes in ~seconds. */
const TITLE_TIMEOUT_MS = 30_000;

/** Reject if `p` doesn't settle within `ms` (clears the timer either way). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("title generation timed out")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Build the titling prompt (BRO-1665). SELF-CONTAINED — the conversation is inlined
 *  (both sides truncated), so the model never needs a tool, and it's told to output
 *  only the title. Keeps the call a single cheap completion. */
export function buildTitlePrompt(userText: string, replyText: string): string {
  const u = userText.trim().slice(0, 600);
  const r = replyText.trim().slice(0, 400);
  const instruction =
    "Generate a concise 3-6 word title summarizing the topic of the conversation below. " +
    "Output ONLY the title — no quotes, no trailing punctuation, no preamble — and do not use any tools.";
  return `${instruction}\n\nUser: ${u}\n${r ? `Assistant: ${r}\n` : ""}`;
}

/** Clean a model-produced title (BRO-1665): first line only, drop a "Title:" lead +
 *  wrapping quotes + trailing punctuation, collapse whitespace, cap ~60 code points.
 *  Empty → undefined (the caller keeps the heuristic title). */
export function sanitizeTitle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let t = (raw.trim().split("\n")[0] ?? "").trim();
  // Strip control + format chars (P20): a NUL would throw in Postgres, and a
  // bidi-override (U+202E) could spoof the displayed title. Do this FIRST.
  t = t.replace(/[\p{Cc}\p{Cf}]/gu, "");
  t = t.replace(/^title:\s*/i, ""); // a "Title: X" lead
  t = t.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, ""); // wrapping quotes/backticks
  t = t
    .replace(/[.。!?]+$/u, "")
    .replace(/\s+/g, " ")
    .trim(); // trailing punctuation + collapse
  if (!t) return undefined;
  const chars = [...t];
  return chars.length > 60 ? `${chars.slice(0, 60).join("").trimEnd()}…` : t;
}

/** Agent CLI args for a workspace, hardened when it serves an untrusted principal.
 *
 *  `--strict-mcp-config` drops every inherited MCP server. It is the ONLY control
 *  that reaches them: MCP servers are separate processes that run OUTSIDE the
 *  filesystem sandbox by documented design, so no amount of path confinement
 *  touches them. Measured on the VPS — without the flag a tenant session carries
 *  mcp__railway__set_variables / update_service / whoami plus the account's Gmail,
 *  Drive and Calendar connectors; with it, the session reports NONE.
 *
 *  Appended AFTER the operator's args, never merged into them: the flag is
 *  boolean, so a later occurrence can only add it. There is deliberately no way
 *  for configuration to remove it from a confined workspace.
 *
 *  Pure + exported so the invariant is covered by a test rather than by a comment. */
export function hardenedExtraArgs(
  workspace: { confined?: boolean },
  extraArgs?: string[],
): string[] | undefined {
  if (!workspace.confined) return extraArgs;
  return [...(extraArgs ?? []), "--strict-mcp-config"];
}

/** BRO-2235 — can this workspace's HOME actually be delivered here? If not, REFUSE.
 *
 *  ONE predicate, not one guard per spawn site. Three review rounds each found the
 *  same defect — a tenant that declares isolation and silently gets the operator's
 *  HOME — in a DIFFERENT cell of the matrix: a relative path, a non-print engine, a
 *  host whose env never reaches the child, the title spawn. An invariant spelled
 *  per-branch is forgotten once per branch, so the branches became the rounds.
 *  Hoisting it means a new engine, host, or spawn site is refused by default rather
 *  than silently unisolated.
 *
 *  THE LINE BETWEEN FAIL-SAFE AND FAIL-CLOSED WAS IN THE WRONG PLACE, and that is
 *  what made the worst of those reachable. `tenantEnv` ignores a blank home AND a
 *  relative one, which conflates two different things:
 *
 *    NO REQUEST        (home unset)     -> proceed. Nothing was asked for, and
 *                                         refusing would turn a provisioning gap
 *                                         into an outage.
 *    UNSATISFIABLE REQUEST (everything  -> REFUSE. Something WAS asked for and
 *     else here)                          cannot be delivered; running anyway
 *                                         serves a tenant from the operator's
 *                                         credential while looking normal.
 *
 *  Measured before the fix: `home: "relative/home"` on the print engine passed the
 *  old engine-only check, then `tenantEnv` dropped the relative path and handed the
 *  child the operator's HOME — the exact failure the guard existed to prevent, and
 *  a test asserted it as correct behaviour.
 *
 *  `hostKind` is optional so this can be asked BEFORE a host lease exists (cheap
 *  checks, no lease to leak) and again AFTER (the host check). Passing undefined
 *  skips only the host clause; it never turns a refusal into a pass.
 *
 *  Pure + exported so the invariant is covered by a test rather than by a comment. */
export function homeRefusal(
  workspace: { home?: string },
  engine: string | undefined,
  hostKind?: string,
): string | undefined {
  const home = workspace.home?.trim();
  if (!home) return undefined; // no isolation requested — the fail-SAFE case

  // Everything below is a request that cannot be honoured. Refuse, do not degrade.
  if (!home.startsWith("/")) {
    return "Workspace declares a per-tenant HOME that is not an absolute path, so it cannot be applied — the turn would run with the operator's HOME. Refusing rather than running unisolated.";
  }
  // ALLOWLIST of one, not a denylist of today's engines: an engine added later is
  // refused until someone threads HOME through it.
  if (engine !== "print") {
    return `Workspace declares a per-tenant HOME, but the "${engine ?? "unknown"}" engine does not carry it — the turn would run with the operator's HOME. Refusing rather than running unisolated.`;
  }
  // Same, for hosts. `packages/host/src/index.ts` says it outright for vps: env
  // "scope[s] the LOCAL ssh-client process, not the remote agent — ssh does not
  // forward arbitrary env". A microVM has its own filesystem, so a host path names
  // nothing inside it. Only a local child actually receives this env.
  if (hostKind !== undefined && hostKind !== "local") {
    return `Workspace declares a per-tenant HOME, but a "${hostKind}" host does not deliver it to the agent process — the turn would run with the operator's HOME. Refusing rather than running unisolated.`;
  }
  return undefined;
}

/** BRO-2236 / BRO-2241 — the fail-closed half of confinement.
 *
 *  `hardenedExtraArgs` above decides whether a turn is hardened. These decide
 *  whether the turn is allowed to happen at all, and they exist because hardening
 *  silently degrades: a workspace that arrives with `confined: undefined` gets the
 *  caller's args back unchanged, so an unconfined tenant looks exactly like a
 *  workspace that was never meant to be confined.
 *
 *  A CHANNEL-QUALIFIED request is one where the caller named a workspace. A public
 *  channel (WhatsApp) always names one; a human picking from the web UI also names
 *  one. In both cases "the id you named is not registered" must refuse rather than
 *  fall back to the default workspace, because the default is the broadest
 *  directory on the box.
 *
 *  Pure + exported so the invariant is covered by a test rather than by a comment. */
export function bindRefusal(
  requested: string | undefined,
  isRegistered: (id: string) => boolean,
): string | undefined {
  if (requested === undefined) return undefined; // no claim made -> default is fine
  if (isRegistered(requested)) return undefined;
  return `Workspace ${requested} is not registered on this host, so this request cannot be served. It will NOT fall back to the default workspace.`;
}

/** BRO-2241 — an existing session's binding is sticky, so a row created before its
 *  channel had a confined workspace keeps pointing at whatever it was bound to,
 *  forever, and `resolve()` never looks at the caller's id again. Measured live:
 *  three sandbox-number rows still bound to `ws-orchestrator`, which carries no
 *  `confined` field at all. Refuse rather than silently serve the stale binding. */
export function rebindRefusal(
  existingWorkspaceId: string,
  requested: string | undefined,
): string | undefined {
  if (requested === undefined) return undefined;
  if (existingWorkspaceId === requested) return undefined;
  return `This thread is bound to workspace ${existingWorkspaceId}, but the request names ${requested}. A binding is not migrated silently. Start a new thread, or re-bind it deliberately.`;
}

export class Supervisor {
  private readonly store: Store;
  private readonly runners: Record<string, RunnerFn>;
  private readonly generateTitles: boolean;
  private readonly controls: Record<string, EngineControl>;
  private readonly defaultEngine: string;
  private readonly trace?: (sessionId: string, event: AgentEvent) => void;
  private readonly onAsk?: SupervisorConfig["onAsk"];
  private readonly hostProvider: HostProvider;
  private readonly extraArgs?: string[];
  private readonly remoteCwd?: string;
  private readonly noWorktree: boolean;
  private readonly defaultWorkspace: Workspace;
  /** id → Workspace CACHE (BRO-1627/1629). Hydrated from the repository by
   *  `ensureWorkspace()`, so the per-turn hot path (resolve/runTurn) reads it
   *  synchronously. Holds the richer registry-only fields (noWorktree/isGitRepo)
   *  that never round-trip through the DB. */
  private workspaceRegistry: Map<string, Workspace> = new Map();
  /** Source of truth for the registry (BRO-1629). Mutations write through here. */
  private readonly workspaceRepository: WorkspaceRepository;
  /** Env-derived seed (default + extras, ws-default reserved) — registered into an
   *  EMPTY repository on first use, migrating the env snapshot into the source. */
  private readonly workspaceSeed: readonly Workspace[];
  /** Per-thread promise chain — serializes dispatches on the same session. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Memoized one-shot persistence of the workspace registry (async ctor work). */
  private workspaceEnsured?: Promise<void>;
  /** rootPath-existence probe (BRO-1629 slice 4 / BRO-1630 RC3); `existsSync` in
   *  production, overridable in tests. */
  private readonly workspaceExists: (rootPath: string) => boolean;
  /** Workspace ids already warned about as missing-on-disk — dedupes the
   *  reconciliation warning across registry reloads (BRO-1630 P20 #4). */
  private readonly warnedMissingWorkspaces = new Set<string>();
  /** Agent-stack seeder (BRO-2252); the real filesystem writer in production. */
  private readonly stackSeeder: (rootPath: string) => void;
  /** Turn admission gate (BRO-2260). */
  private readonly gate: TurnGate;
  private readonly turnIdleTimeoutMs?: number;
  private readonly turnMaxMs?: number;

  constructor(cfg: SupervisorConfig) {
    this.store = cfg.store ?? new InMemoryStore();
    // Engine registry (BRO-1620). `print` (runAgent) is always available; explicit
    // `runners` win; a legacy single `run` keys to defaultEngine.
    this.defaultEngine = cfg.defaultEngine ?? "print";
    this.runners = {
      print: runAgent,
      ...(cfg.runners ?? (cfg.run ? { [this.defaultEngine]: cfg.run } : {})),
    };
    this.controls = cfg.controls ?? (cfg.control ? { [this.defaultEngine]: cfg.control } : {});
    // defaultEngine must resolve to a registered runner (e.g. interactive requested
    // but unavailable on a microVM host → fall back to print).
    if (!this.runners[this.defaultEngine]) this.defaultEngine = "print";
    this.generateTitles = cfg.generateTitles ?? false;
    this.trace = cfg.trace;
    this.onAsk = cfg.onAsk;
    this.hostProvider =
      cfg.hostProvider ?? new StaticHostProvider(cfg.host ?? new LocalHost(), cfg.remoteCwd);
    this.extraArgs = cfg.extraArgs;
    this.remoteCwd = cfg.remoteCwd;
    this.noWorktree = cfg.noWorktree ?? false;
    this.workspaceExists = cfg.workspaceExists ?? existsSync;
    this.stackSeeder =
      cfg.stackSeeder ??
      ((rootPath: string) => {
        seedAgentStack(rootPath);
      });
    this.gate = new TurnGate(cfg.concurrency ?? {});
    this.turnIdleTimeoutMs = cfg.turnIdleTimeoutMs;
    this.turnMaxMs = cfg.turnMaxMs;
    this.defaultWorkspace = cfg.defaultWorkspace;
    // Build the env-derived SEED (BRO-1627 order preserved): default first, then the
    // boot-discovered workspaces (a later extra with the same id wins). The default
    // id is RESERVED (P20 M2): an extra colliding with it — a repo that slugs to
    // `ws-default`, or an explicit override — must not shadow the genuine default,
    // or every default-bound thread would silently re-cwd. Skip + warn.
    const seed = new Map<string, Workspace>();
    seed.set(cfg.defaultWorkspace.id, cfg.defaultWorkspace);
    for (const w of cfg.workspaces ?? []) {
      if (w.id === cfg.defaultWorkspace.id) {
        console.warn(
          `[genesis] workspace "${w.id}" collides with the default workspace id; ignoring (the default can't be overridden).`,
        );
        continue;
      }
      seed.set(w.id, w);
    }
    this.workspaceSeed = [...seed.values()];
    // The repository is the source of truth (BRO-1629). Default: in-memory, seeded
    // from env (== the BRO-1627 registry). The FS adapter makes it runtime-mutable.
    this.workspaceRepository =
      cfg.workspaceRepository ?? new InMemoryWorkspaceRepository(this.workspaceSeed);
  }

  private ensureWorkspace(): Promise<void> {
    // Memoized registry hydration (BRO-1629). Clear the memo on rejection so a
    // transient first-dispatch failure (e.g. a Postgres/FS blip) doesn't poison
    // every later dispatch (P20 #1).
    this.workspaceEnsured ??= this.loadRegistry().catch((e) => {
      this.workspaceEnsured = undefined;
      throw e;
    });
    return this.workspaceEnsured;
  }

  /** Hydrate the cache from the repository (BRO-1629). Seeds an EMPTY repository
   *  from the env seed (migrating the boot snapshot into the source of truth),
   *  always ensures the default is present, refreshes the in-memory cache, and
   *  mirrors the set into the Store's workspaces table (the deconfigured-workspace
   *  DB fallback, BRO-1627 S1). Re-runnable; register/remove invalidate the memo. */
  private async loadRegistry(): Promise<void> {
    let all = await this.workspaceRepository.list();
    // Seed an empty repository (first boot / fresh FS root) from the env snapshot.
    if (all.length === 0 && this.workspaceSeed.length > 0) {
      for (const w of this.workspaceSeed) await this.workspaceRepository.register(w);
      all = await this.workspaceRepository.list();
    }
    // The default workspace is ALWAYS present (register it if the source lacks it).
    if (!all.some((w) => w.id === this.defaultWorkspace.id)) {
      await this.workspaceRepository.register(this.defaultWorkspace);
      all = await this.workspaceRepository.list();
    }
    // Build the cache DEFAULT-FIRST + the genuine default AUTHORITATIVE
    // (CodeRabbit L260 + P20 M2 Finding #1): a repository/manifest entry sharing the
    // default id — a different rootPath/name — must NOT shadow the genuine default
    // (else every default-bound thread re-cwds), and listWorkspaces() documents
    // "default first" regardless of repository insertion order.
    const nonDefault = all.filter((w) => w.id !== this.defaultWorkspace.id);
    this.workspaceRegistry = new Map<string, Workspace>([
      [this.defaultWorkspace.id, this.defaultWorkspace],
      ...nonDefault.map((w) => [w.id, w] as [string, Workspace]),
    ]);
    // Reconciliation observability (BRO-1629 slice 4 / BRO-1630 RC3): warn LOUDLY
    // for any registered workspace whose rootPath has vanished from disk — the
    // dispatch-time guard blocks binding it, but this signal lets the operator
    // recreate the dir (or re-point GENESIS_WORKSPACE) before a user hits it.
    // Especially important for the DEFAULT workspace, which cannot be removed.
    // loadRegistry re-runs on EVERY runtime mutation (refreshRegistry), so dedupe
    // per id (P20 #4): warn once while missing, re-arm when the dir reappears.
    for (const w of this.workspaceRegistry.values()) {
      if (!this.workspaceExists(w.rootPath)) {
        if (!this.warnedMissingWorkspaces.has(w.id)) {
          this.warnedMissingWorkspaces.add(w.id);
          console.warn(
            `[genesis] workspace "${w.id}" rootPath is missing on disk${w.id === this.defaultWorkspace.id ? " (this is the DEFAULT workspace — new threads will fail until it exists)" : ""}. Threads bound to it will be refused at dispatch until the directory is restored.`,
          );
        }
      } else {
        this.warnedMissingWorkspaces.delete(w.id); // reappeared → allow a future re-warn
      }
    }
    // Mirror the CORRECTED set into the Store (idempotent) so a thread bound to a
    // since-removed workspace keeps its last-known rootPath for the never-ran
    // fallback (S1) — and the mirrored default row is the genuine one, not a shadow.
    await Promise.all(
      [...this.workspaceRegistry.values()].map((w) => this.store.upsertWorkspace(w)),
    );
  }

  /** Re-read the workspace registry from its source (BRO-2230).
   *
   *  The registry is an in-memory Map hydrated at boot and invalidated only by
   *  mutations made THROUGH this supervisor. A manifest written directly to the
   *  registry directory — which is how tenant workspaces are provisioned, as
   *  root, out of band — is therefore invisible until the process restarts.
   *
   *  Measured consequence of not having this: after provisioning a new tenant,
   *  genesis-bot asked the api whether the workspace existed, was told no, and
   *  refused to serve WhatsApp AT ALL, crash-looping and taking the channel down
   *  for every EXISTING tenant until the api was restarted too. At one tenant
   *  that is an annoyance; at ten it is an outage per onboarding.
   *
   *  Serialized through the same chain as every other refresh, so a reload
   *  racing a register cannot install a stale snapshot. */
  reloadWorkspaces(): Promise<void> {
    return this.refreshRegistry();
  }

  /** Serialized registry refresh (CodeRabbit/Forge #2). Chains the reload onto the
   *  current hydration so two concurrent runtime mutations can't run overlapping
   *  `loadRegistry`s and have the SLOWER one overwrite the cache with a stale
   *  snapshot. Every registry read still awaits `ensureWorkspace()` = this chain. */
  private refreshRegistry(): Promise<void> {
    const next = (this.workspaceEnsured ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.loadRegistry());
    this.workspaceEnsured = next.catch((e) => {
      this.workspaceEnsured = undefined;
      throw e;
    });
    return this.workspaceEnsured;
  }

  /** Ensure a newly registered workspace comes up already holding the bstack
   *  agent stack in `.claude/agents` (BRO-2252). Measured: `claude -p` discovers
   *  project-level agent files, so this is the difference between a workspace
   *  that knows the discipline and one that must be told it inline every turn.
   *
   *  GUARDED ON LOCAL EXISTENCE, deliberately. The seeder is `node:fs` — it
   *  assumes the workspace root is on THIS filesystem. True for LocalHost, false
   *  for the phase-2 microVM substrate, where writing here would silently create
   *  a directory on the VPS that the tenant's real host never sees.
   *
   *  The guard is the REAL `existsSync`, NOT the injected `this.workspaceExists`.
   *  That injection exists so tests can assert "yes" for fake rootPaths like
   *  `/repos/live` and bypass the vanished-workspace guard — which is exactly
   *  the lie that must not reach a function doing real `mkdirSync`. Honouring it
   *  here would have any such test create directories at the filesystem root.
   *  A caller who wants to observe the seed injects `stackSeeder` instead.
   *
   *  NEVER THROWS. A workspace with no seeded agents is a working workspace; a
   *  registration that fails because a markdown file could not be written is not.
   *  Loud on stderr rather than silent — a stack that did not land is precisely
   *  the state where "we rolled it out" and "it is running" disagree. */
  private seedStack(ws: Workspace): void {
    if (!existsSync(ws.rootPath)) return;
    try {
      this.stackSeeder(ws.rootPath);
    } catch (e) {
      console.error(
        `[genesis] could not seed the agent stack into ${ws.rootPath}/.claude/agents (${e instanceof Error ? e.message : e}) — the workspace is registered and usable, but its sessions start without the stack.`,
      );
    }
  }

  /** Register a workspace at RUNTIME (BRO-1629) — writes the source + refreshes the
   *  live cache, no restart. The caller (an auth-gated endpoint) MUST derive +
   *  validate `rootPath` server-side; the client never names a filesystem path. */
  async registerWorkspace(ws: Workspace): Promise<Workspace> {
    if (ws.id === this.defaultWorkspace.id) {
      throw new Error(`workspace id "${ws.id}" is reserved for the default workspace`);
    }
    // Idempotent by rootPath (BRO-1629; a P11 dogfood caught this): a sequential
    // double-submit of the same pick resolves to a fresh DISAMBIGUATED id (the
    // first registration made the clean id "taken") but the SAME rootPath —
    // registering it would create a second workspace pointing at one directory.
    // A directory IS the workspace, so if one is already registered at this
    // rootPath, return it unchanged. (The concurrent case — both submissions see
    // the clean id free → both resolve to it → the repository's register is
    // idempotent-by-id, collapsing to one. So the two paths together close the
    // gap review reasoned around by assuming exactly-once submission.)
    const existing = [...this.workspaceRegistry.values()].find((w) => w.rootPath === ws.rootPath);
    if (existing) return existing;
    this.seedStack(ws);
    const saved = await this.workspaceRepository.register(ws);
    await this.refreshRegistry();
    return saved;
  }

  /** De-register a workspace (BRO-1629). The default can't be removed. A thread
   *  already bound to a removed workspace keeps its binding and errors on its next
   *  turn if it ran (the BRO-1627 S1 guard) — removal is safe for the registry,
   *  not retroactive on live threads. Returns false if id is the default. */
  async removeWorkspace(id: string): Promise<boolean> {
    if (id === this.defaultWorkspace.id) return false;
    await this.workspaceRepository.remove(id);
    await this.refreshRegistry();
    return true;
  }

  /** chat-id/thread → Session. A NEW thread binds the requested workspace (BRO-1627)
   *  if it's registered, else the default; an existing thread is returned unchanged
   *  (the binding is sticky from session creation — switching = a new thread). */
  async resolve(
    threadId: string,
    workspaceId?: string,
    channelQualified?: boolean,
  ): Promise<Session> {
    await this.ensureWorkspace();
    const existing = await this.store.findSessionByThread(threadId);
    if (existing) {
      // BRO-2241: sticky is right for a human switching workspaces mid-thread, and
      // wrong for a channel, where a stale binding can point at an UNCONFINED
      // workspace the tenant was never meant to reach.
      const stale = channelQualified ? rebindRefusal(existing.workspaceId, workspaceId) : undefined;
      if (stale) throw new Error(stale);
      return existing;
    }
    // BRO-2236: a named-but-unregistered id falls through to the default workspace,
    // which on a public channel is an escalation rather than a convenience.
    const refusal = channelQualified
      ? bindRefusal(workspaceId, (id) => this.workspaceRegistry.has(id))
      : undefined;
    if (refusal) throw new Error(refusal);
    // Validate the requested id against the live registry at bind time (mirror the
    // engine `this.runners[requested] ? …` discipline); unknown → default.
    const bound =
      workspaceId && this.workspaceRegistry.has(workspaceId)
        ? workspaceId
        : this.defaultWorkspace.id;
    return this.store.upsertSession({
      id: newId("sess"),
      workspaceId: bound,
      threadId,
      phase: "idle", // a never-run session is idle, not done (F20)
      createdAt: isoNow(),
    });
  }

  /** Run one turn, serialized against any in-flight turn on the same thread. */
  dispatch(
    threadId: string,
    text: string,
    onState?: (state: RunState, event: AgentEvent) => void,
    turnOpts?: TurnOptions,
  ): Promise<DispatchResult> {
    return this.enqueue(threadId, () => this.runTurn(threadId, text, onState, turnOpts));
  }

  /** Serialize `work` onto the per-thread chain (F19) — the single mechanism that
   *  orders everything touching one thread's session. Turns AND session mutations
   *  (archive/rename/delete) run through it, so a mutation never interleaves with
   *  an in-flight turn's phase/session write-back (which would clobber archived/
   *  title or resurrect a deleted row). Compare-and-delete on settle keeps the map
   *  bounded and never evicts a newer enqueue's entry. */
  private enqueue<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(threadId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(work);
    const guarded = next.catch(() => {});
    this.chains.set(threadId, guarded);
    void guarded.then(() => {
      if (this.chains.get(threadId) === guarded) this.chains.delete(threadId);
    });
    return next;
  }

  private async runTurn(
    threadId: string,
    text: string,
    onState?: (state: RunState, event: AgentEvent) => void,
    turnOpts?: TurnOptions,
  ): Promise<DispatchResult> {
    const session = await this.resolve(threadId, turnOpts?.workspaceId, turnOpts?.channelQualified);
    // Resolve the bound workspace registry-FIRST (BRO-1627) — the registry carries
    // the richer noWorktree/isGitRepo the DB row does NOT. A thread that already RAN
    // under a workspace no longer in the registry can't be safely resumed (P20 S1):
    // the persisted DB row has only id/name/rootPath, so the worktree posture is
    // lost — resuming could enable worktrees on a nested-repo workspace and run
    // --resume against a broken tree. Error instead of silently re-cwd'ing. (A
    // registry hit is fine; a never-ran thread can safely fall back — no resume to
    // break — to its last-known DB row, else the default.)
    const registered = this.workspaceRegistry.get(session.workspaceId);
    if (!registered && session.agentSessionId !== undefined) {
      throw new Error(
        `This thread's workspace (${session.workspaceId}) is no longer available; it can't be resumed elsewhere. Start a new thread to pick a workspace.`,
      );
    }
    const workspace =
      registered ?? (await this.store.getWorkspace(session.workspaceId)) ?? this.defaultWorkspace;
    // Worktree posture (BRO-1656 layered on BRO-1512). The DEFAULT is the workspace's
    // posture, else the deploy global — both mark "run at root" for a nested-repo
    // context where worktrees break.
    const defaultNoWorktree = workspace.noWorktree ?? this.noWorktree;
    // FREEZE the effective posture on the first turn (mirrors the engine bind). A
    // thread's cwd must not change across turns — `claude --resume` is cwd-scoped, so
    // an inheriting thread bouncing root↔worktree when the workspace default later
    // flips would break continuity (CodeRabbit). So the derived posture is persisted
    // once and reused. Derivation, most-restrictive first:
    //   - explicit ROOT (worktree:false) → root (always safe);
    //   - explicit WORKTREE (worktree:true) → worktree ONLY where the REGISTRY vouches
    //     the workspace allows it (registry carries the real `noWorktree`; a DB-row
    //     fallback drops it, so an unverifiable workspace stays root — P20 F5);
    //   - INHERIT (undefined) → the registered default, else root (unverifiable).
    // ADMIT BEFORE ANY MUTATION (P20 round 2 major). The freeze below writes
    // `session.noWorktree`, so admitting after it meant a REFUSED request could
    // permanently fix an idle session's worktree posture and change how the
    // eventual resend runs. A refusal must leave nothing behind.
    let slot: TurnSlot;
    try {
      slot = this.gate.acquire(workspace.id);
    } catch (e) {
      // A REFUSAL MUST LEAVE A TRACE (BRO-2308). `acquire` throws before the try
      // below that owns the `dispatch ✖` logging, so a refused turn reached the
      // client correctly and left NOTHING server-side — measured: zero matches
      // across 24h of logs while refusals were actively firing.
      //
      // That makes "are we hitting capacity?" unanswerable, which is the entire
      // operational question this gate exists to manage; and a stuck-closed gate
      // (a leaked slot) would refuse every user while the logs looked normal.
      //
      // Ids and counts ONLY — never the turn text. On a shared number the message
      // belongs to a tenant, and the rest of this path is already careful about it.
      if (e instanceof TurnRejectedError) {
        console.warn(
          `[genesis] dispatch ⊘ thread=${threadId} workspace=${workspace.id} refused ` +
            `(${e.scope} limit ${e.limit}) — in flight: workspace=${this.gate.activeFor(workspace.id)} global=${this.gate.active}`,
        );
      }
      throw e;
    }
    try {
      if (session.noWorktree === undefined && session.agentSessionId === undefined) {
        const canWorktree = !!registered && !defaultNoWorktree;
        session.noWorktree =
          turnOpts?.worktree === false
            ? true
            : turnOpts?.worktree === true
              ? !canWorktree
              : registered
                ? defaultNoWorktree
                : true;
      }
      // The frozen choice wins, EXCEPT a stored "worktree" (false) is still downgraded to
      // root if the default now FORBIDS one (the workspace became nested since the freeze)
      // — safety beats resume continuity: a broken worktree checkout is worse than a
      // broken resume. (`?? defaultNoWorktree` covers legacy pre-BRO-1656 ran rows that
      // never froze a posture.)
      const noWorktree =
        session.noWorktree === false && defaultNoWorktree
          ? true
          : (session.noWorktree ?? defaultNoWorktree);
      await this.store.addTurn({ sessionId: session.id, role: "user", text });

      // Derive a thread title from the first user turn (BRO-1592) — persisted with
      // the phase write below, so the drawer shows a stable label instead of a
      // running last-text preview. Never overwrites a title once set (or renamed).
      // This is the INSTANT provisional; an LLM title upgrades it after the turn
      // (BRO-1665), fired once — on the turn that first titles the thread.
      const titledThisTurn = !session.title;
      if (!session.title) session.title = deriveTitle(text);
      // Bind the engine STICKY on the first turn (BRO-1620), reused for every later
      // turn — so flipping the global default never reroutes a thread with a live
      // session. A brand-new thread (never ran) takes the client's requested engine;
      // an EXISTING thread with no engine (a pre-BRO-1620 row) is bound to the DEFAULT
      // instead, preserving the engine it actually ran under (the deploy's
      // GENESIS_ENGINE) so it can't be silently rerouted + lose --resume continuity.
      if (!session.engine) {
        const neverRan = session.agentSessionId === undefined;
        const requested = turnOpts?.engine;
        session.engine =
          neverRan && requested && this.runners[requested] ? requested : this.defaultEngine;
      }
      // BRO-2235. Placement is load-bearing three ways.
      //
      // AFTER the engine binding above: the binding decides whether `home` will
      // actually travel, so a workspace can be correct and the turn still unisolated
      // purely from which engine the thread landed on.
      //
      // BEFORE `phase = "running"` is persisted: a refusal here leaves the session in
      // whatever phase it already held. Refusing after the write stranded it in
      // "running" permanently — the row never returns to a runnable state.
      //
      // BEFORE the host lease: this throw is outside the try/finally that releases
      // one, so refusing costs no host and leaks nothing.
      const preLeaseRefusal = homeRefusal(workspace, session.engine ?? this.defaultEngine);
      if (preLeaseRefusal) throw new Error(preLeaseRefusal);

      session.phase = "running";
      await this.store.upsertSession(session);

      // Engine-agnostic turn logging (BRO-1519) — ties thread → session → outcome
      // in the api log, for the print engine + /message too.
      const startedAt = Date.now();
      console.log(`[genesis] dispatch ▶ thread=${threadId} session=${session.id}`);

      // Lease a host for THIS session (e.g. its own per-session microVM).
      const lease = await this.hostProvider.resolveHost({ id: session.id, threadId });
      // Resolve the runner for this thread's (now-bound) engine; the default + the
      // built-in print runner are the safety net (engine was validated at bind time,
      // so this always hits the first — the fallbacks just satisfy the type checker).
      const run =
        this.runners[session.engine ?? this.defaultEngine] ??
        this.runners[this.defaultEngine] ??
        runAgent;
      try {
        // Workspace-availability guard (BRO-1629 slice 4 / BRO-1630 RC3): refuse to
        // run into a rootPath that has vanished from disk (deleted out-of-band, an
        // unmounted volume). Without this, a LOCAL spawn falls back to the process
        // cwd (e.g. /home/agent) and the agent silently runs in the WRONG place —
        // the "working directory isn't a git repo" symptom. The error names the
        // workspace, never its rootPath (that path must not leak past the engine).
        //
        // Scope — LOCAL hosts only (a `microvm` host runs the repo INSIDE the VM, so
        // a local existsSync of rootPath is meaningless and would false-positive).
        // KNOWN GAP (P20 #2): a `vps` host runs over ssh with rootPath as a REMOTE
        // path — a vanished remote dir reproduces this exact bug, but a local
        // existsSync can't see it; it needs a remote `test -d` via host.exec. VpsHost
        // is not yet wired into the api (only LocalHost + microVM ship today), so
        // this is latent — tracked for when vps is instantiated (BRO-1631).
        // BRO-2235, second half: the host is only known once leased. Inside the try,
        // so the finally releases the lease this refusal abandons.
        const hostRefusal = homeRefusal(
          workspace,
          session.engine ?? this.defaultEngine,
          lease.host.kind,
        );
        if (hostRefusal) throw new Error(hostRefusal);
        if (lease.host.kind === "local" && !this.workspaceExists(workspace.rootPath)) {
          throw new Error(
            `Workspace "${workspace.name}" is unavailable — its directory no longer exists on the server. Recreate it, or start a new thread in another workspace.`,
          );
        }
        const result = await run({
          prompt: text,
          cwd: workspace.rootPath,
          // Turn bounds (BRO-2260). Two clocks: `idle` catches a wedged child,
          // `max` catches a turn that keeps emitting while pinning the box — the
          // BRO-2275 shape, which an idle timer would never have fired on.
          idleTimeoutMs: this.turnIdleTimeoutMs,
          maxTurnMs: this.turnMaxMs,
          resumeSessionId: session.agentSessionId,
          host: lease.host,
          extraArgs: hardenedExtraArgs(workspace, this.extraArgs),
          // BRO-2235: the tenant's own HOME, when it has one. Unset leaves the
          // server's HOME in place, which is the current behaviour.
          home: workspace.home,
          // Per-turn model/effort (BRO-1573) override the constructor defaults.
          model: turnOpts?.model,
          effort: turnOpts?.effort,
          remoteCwd: lease.remoteCwd ?? this.remoteCwd,
          // Stable per-session worktree → reused across turns so claude --resume
          // finds its cwd-scoped session (multi-turn continuity on LocalHost).
          // noWorktree → run directly in the workspace (BRO-1512: nested-repo cwd).
          sessionKey: session.id,
          worktree: noWorktree ? false : undefined,
          // Multimodal attachments (BRO-1706) — the runner writes them into the
          // resolved cwd and appends their paths to the prompt.
          attachments: turnOpts?.attachments,
          onState: (state, event) => {
            // THE EDGE, not the state. `onState` fires per event, so emitting
            // whenever the phase IS "awaiting" would re-append the same ask on
            // every subsequent event of a blocked turn. Captured before the
            // assignment below, which is the only place the previous phase still
            // exists.
            const wasAwaiting = session.phase === "awaiting";
            session.phase = state.phase;
            // The ask log's producer (BRO-2413). Hooked HERE and nowhere else:
            // all three runners (index.ts, interactive.ts, codex.ts) call
            // `onState` immediately after `reduce`, so this one site sees every
            // engine. Hooking the three reduce call sites instead would be a rule
            // spelled per-site, which is the shape that cost the ask log four
            // review rounds.
            if (this.onAsk && !wasAwaiting && state.phase === "awaiting") {
              const createdAt = new Date().toISOString();
              for (const raised of asksRaisedBy(event)) {
                // Guarded like `trace` above, and for the same reason: a
                // side-channel that throws must not fail the turn the operator
                // is waiting on. A lost ask is bad; a lost turn is worse.
                try {
                  this.onAsk({
                    id: raised.toolUseId,
                    sessionId: session.id,
                    threadId: session.threadId,
                    question: raised.question,
                    ...(raised.header !== undefined ? { header: raised.header } : {}),
                    ...(raised.options !== undefined ? { options: raised.options } : {}),
                    ...(raised.multiSelect !== undefined
                      ? { multiSelect: raised.multiSelect }
                      : {}),
                    createdAt,
                  });
                } catch (e) {
                  console.error(
                    `[genesis] ask producer failed (session=${session.id}): ${e instanceof Error ? e.message : String(e)}`,
                  );
                }
              }
            }
            // Tracing is side-channel — a throwing trace hook must NOT fail the
            // turn (CodeRabbit #18). Guard at the call site, not just in the impl.
            if (this.trace) {
              try {
                this.trace(session.id, event);
              } catch (e) {
                console.error(
                  `[genesis] trace hook failed (session=${session.id}): ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            }
            onState?.(state, event);
          },
        });

        if (result.state.sessionId) session.agentSessionId = result.state.sessionId;
        // Capture the cwd's branch (BRO-1664) — refreshes each turn (worktree branch or
        // the root repo's current branch). Only when the run resolved one; a non-git cwd
        // or a transient failure keeps the last-known value.
        if (result.branch) session.branch = result.branch;
        session.phase = result.state.phase;
        await this.store.upsertSession(session);

        const reply = result.state.lastText ?? "(no output)";
        const usage = result.state.usage;
        const costUsd = result.state.costUsd;
        const durationMs = Date.now() - startedAt; // server-measured run time (BRO-1610)
        // Persist the ordered timeline + thinking estimate (BRO-1607) alongside
        // usage/cost (BRO-1597) + run time (BRO-1610) so a reloaded thread rebuilds
        // tool blocks, text interleaving, the reasoning indicator, and "Xm Ys".
        const parts = result.state.parts;
        await this.store.addTurn({
          sessionId: session.id,
          role: "agent",
          text: reply,
          usage,
          costUsd,
          durationMs,
          parts: parts && parts.length > 0 ? parts : undefined,
          thinkingTokens: result.state.thinkingTokens,
          reasoned: result.state.reasoned,
          // Verbatim prose only when the deployment provides it (BRO-1608) — "" under
          // subscription auth, so the reload falls back to the indicator note.
          reasoning: result.state.reasoning?.trim() ? result.state.reasoning : undefined,
        });

        // Upgrade the instant heuristic title to an LLM-generated one (BRO-1665) — once,
        // on the first turn, with a real reply to summarize. Fire-and-forget: it must
        // never add latency to (or fail) the turn; the drawer poll surfaces the new
        // title a moment later. A failure keeps the heuristic.
        if (this.generateTitles && titledThisTurn && reply && result.state.lastText !== undefined) {
          void this.generateTitleAsync(threadId, text, reply);
        }

        // Keep a per-session worktree across turns (resume continuity); only
        // discard a one-shot per-run worktree.
        if (result.worktreePath && !result.worktreePersistent) {
          await removeWorktree(
            workspace.rootPath,
            result.worktreePath,
            result.branch,
            lease.host,
          ).catch((e) => console.error(`[genesis] worktree cleanup failed: ${e}`));
        }

        const elapsed = (durationMs / 1000).toFixed(1);
        const noOutput = result.state.lastText === undefined ? " NO-OUTPUT" : "";
        console.log(
          `[genesis] dispatch ✓ thread=${threadId} phase=${result.state.phase}${noOutput} ` +
            `reply=${reply.length}c ${elapsed}s`,
        );
        return { session, reply, phase: result.state.phase, usage, costUsd, durationMs };
      } catch (e) {
        // A THROWN dispatch error (the availability guard, a host-lease failure, a
        // runner that throws) bypasses the runner's own F20 reconcile, which would
        // otherwise leave the session persisted as `phase: "running"` — a PHANTOM
        // spinner in the UI that never resolves (BRO-1630 P20 #1). The in-process
        // catch runs (unlike a process crash, which boot reconcile handles), so
        // reset the truth to `blocked` here. Best-effort: a failing upsert must not
        // mask the original error.
        if (session.phase === "running") {
          session.phase = "blocked";
          await this.store.upsertSession(session).catch(() => {});
        }
        // Full server-side detail (BRO-1519) — previously the error was swallowed
        // and only a generic "Something went wrong" reached the user.
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.error(
          `[genesis] dispatch ✖ thread=${threadId} session=${session.id} ${elapsed}s — ` +
            `${e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e)}`,
        );
        throw e;
      } finally {
        await lease.release?.().catch((e) => console.error(`[genesis] host release failed: ${e}`));
      }
    } finally {
      // Held from before the first side effect to after the last one, so the slot
      // covers the whole turn rather than only the spawn.
      slot.release();
    }
  }

  /** Generate a semantic LLM title for a thread and write it back (BRO-1665).
   *  Best-effort, fired-and-forgotten from the first turn: a fresh `haiku` one-shot
   *  via the PRINT engine (independent of the thread's own engine), the conversation
   *  inlined so it needs no tools + no worktree. On success it re-reads the session
   *  and writes ONLY the title — and only while the title is still the heuristic, so a
   *  user rename (or a re-fire) is never clobbered. Any failure keeps the heuristic. */
  private async generateTitleAsync(
    threadId: string,
    userText: string,
    replyText: string,
  ): Promise<void> {
    const print = this.runners.print;
    if (!print) return;
    let lease: HostLease | undefined;
    let titleSlot: TurnSlot | undefined;
    try {
      const session = await this.store.findSessionByThread(threadId);
      if (!session) return;
      // STRICT, no `?? this.defaultWorkspace` fallback (BRO-2235). A session bound
      // to a workspace that has since left the registry used to fall back here — so
      // untrusted tenant text would be titled under the DEFAULT workspace, whose
      // home is unset or belongs to someone else. Titling is fire-and-forget and
      // entirely optional, so skipping it is free; running it against the wrong
      // identity is not.
      const bound = session.workspaceId
        ? this.workspaceRegistry.get(session.workspaceId)
        : undefined;
      if (session.workspaceId && !bound) return;
      const workspace = bound ?? this.defaultWorkspace;
      lease = await this.hostProvider.resolveHost({ id: session.id, threadId });
      // The SAME predicate as the turn. `generateTitleAsync` calls `runners.print`
      // directly, so it bypassed the turn's guard entirely — and it is the spawn
      // that inlines untrusted tenant text, which makes it the worse one to leave
      // unisolated. Returning (not throwing) because a title is optional.
      if (homeRefusal(workspace, "print", lease.host.kind)) return;
      // Bound the title spawn on its OWN budget (BRO-2260; blocker 2 found by P20
      // round 1, then corrected by round 2).
      //
      // Round 1: titling called `runners.print` directly and so bypassed the gate
      // entirely — every completed turn could start another invisible `claude -p`.
      // Round 2: gating it on the TURN budget was worse than the hole it closed.
      // Titling starts the instant a turn finishes, so at perWorkspace=1 it
      // deterministically took the slot the turn had just released and the user's
      // very next message was refused — by cosmetics.
      //
      // A separate ceiling gives both properties: decoration is bounded, and it can
      // never refuse real work. `undefined` means "no budget" → skip silently.
      titleSlot = this.gate.acquireTitle();
      if (!titleSlot) return;
      // Bound the call (P20): a hung `claude -p` must not hold the lease / dangle a
      // promise forever. The late rejection is swallowed so it can't unhandled-reject.
      const runP = print({
        prompt: buildTitlePrompt(userText, replyText),
        cwd: workspace.rootPath,
        host: lease.host,
        model: TITLE_MODEL, // small + fast (haiku), independent of the thread's engine
        worktree: false, // titling needs no isolation
        remoteCwd: lease.remoteCwd ?? this.remoteCwd,
        // Deliberately DO NOT forward `this.extraArgs` (P20/CodeRabbit): those carry
        // the real agent's permission flags (e.g. --dangerously-skip-permissions). The
        // title prompt inlines UNTRUSTED user/assistant text, so a prompt injection must
        // not be able to escalate into tool/file access here.
        //
        // But NOT forwarding them also meant not forwarding `--strict-mcp-config`, so
        // this spawn inherited the OPERATOR's MCP servers -- Gmail, Drive, Calendar,
        // Railway -- inside a turn whose prompt is written by a tenant. The mitigation
        // in place was "default permissions + a 'do not use any tools' instruction",
        // and an instruction is precisely what a prompt injection overrides. A
        // confined workspace must be confined on every spawn it causes, not only the
        // one the operator is thinking about.
        //
        // `hardenedExtraArgs(workspace)` with no second argument yields exactly
        // ["--strict-mcp-config"] when confined and undefined otherwise, which adds
        // the boundary without reintroducing any permission flag.
        extraArgs: hardenedExtraArgs(workspace),
        // BRO-2235: HOME travels here TOO, for the reason the paragraph above
        // gives for MCP — "a confined workspace must be confined on every spawn it
        // causes". Titling inlines untrusted tenant text; leaving it on the
        // operator's HOME would run that text against the operator's credential
        // and skills, which is the exact hole --strict-mcp-config was added to
        // close, one layer down.
        home: workspace.home,
        // A REAL bound, not just a race (BRO-2260). `withTimeout` below abandons
        // the promise; it does not kill the child. A hung title spawn therefore
        // outlived its own timeout forever, holding memory in the same cgroup as
        // live turns. These bounds make the child actually die.
        maxTurnMs: TITLE_TIMEOUT_MS,
        idleTimeoutMs: TITLE_TIMEOUT_MS,
      });
      // Release on the CHILD's settlement, not the race's (P20 round 2). Losing the
      // race below returns while the child is still being killed — the escalation
      // has a grace period — so releasing in the outer `finally` would hand the
      // budget back while the process it accounts for is still alive.
      const held = titleSlot;
      titleSlot = undefined;
      runP.catch(() => {}).finally(() => held.release());
      const result = await withTimeout(runP, TITLE_TIMEOUT_MS);
      const title = sanitizeTitle(result.state.lastText);
      if (!title) return;
      // Atomic, title-ONLY update (P20): replace the heuristic only while it's still
      // the heuristic — never clobbers a concurrent turn's phase/agentSessionId/branch
      // (a whole-row upsert from this stale snapshot would) nor a user rename.
      const updated = await this.store.updateSessionTitle(session.id, title, deriveTitle(userText));
      if (updated) console.log(`[genesis] title ✓ thread=${threadId} "${title}"`);
    } catch (e) {
      console.error(
        `[genesis] title generation failed (thread=${threadId}): ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      titleSlot?.release();
      await lease?.release?.().catch(() => {});
    }
  }

  async history(threadId: string): Promise<Turn[]> {
    const s = await this.store.findSessionByThread(threadId);
    return s ? this.store.turnsForSession(s.id) : [];
  }

  /** Every thread, newest-first, for the PWA thread drawer (BRO-1567). Reads the
   *  last turn per session for a preview — N+1 over sessions, fine at single-user
   *  scale (one owner, a handful of threads); revisit with a JOIN if it grows. */
  async listThreads(): Promise<ThreadSummary[]> {
    await this.ensureWorkspace(); // hydrate the cache so workspaceName resolves (BRO-1629)
    const sessions = await this.store.listSessions();
    const summaries = await Promise.all(
      sessions.map(async (s): Promise<ThreadSummary> => {
        const turns = await this.store.turnsForSession(s.id);
        return {
          threadId: s.threadId,
          phase: s.phase,
          createdAt: s.createdAt,
          lastText: turns.at(-1)?.text,
          title: s.title,
          archived: s.archived ?? false,
          engine: s.engine,
          workspaceId: s.workspaceId,
          workspaceName: this.workspaceRegistry.get(s.workspaceId)?.name,
          noWorktree: s.noWorktree,
          branch: s.branch,
        };
      }),
    );
    // Newest-first by createdAt (ISO strings sort lexicographically).
    return summaries.sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
  }

  /** The engine ids registered on this Supervisor (always includes `print`; plus
   *  interactive/codex when the boot registered them). The api advertises these
   *  via /health so a client can avoid OFFERING an engine the box can't run —
   *  without that, a request for an unregistered engine binds the default engine
   *  STICKY with no signal to the user (BRO-1620 cross-engine gap; the UI gating
   *  that consumes this is the BRO-1622 follow-up). P20 BRO-1621. */
  get engines(): string[] {
    return Object.keys(this.runners);
  }

  /** The engine a thread binds when none (or an unavailable one) is requested. */
  get defaultEngineId(): string {
    return this.defaultEngine;
  }

  /** The selectable workspaces for the API surface (BRO-1627), default first — a
   *  PUBLIC DTO that OMITS the filesystem `rootPath` (and the registry-only
   *  `noWorktree`): the client picker needs only id + name, and a rootPath must
   *  not leak past the engine even to an authenticated client (P20/CodeRabbit,
   *  defense-in-depth). Internal cwd resolution reads the registry directly, never
   *  this. Registry-backed (no Store round-trip — the live set is in memory).
   *
   *  `available` (BRO-1629 slice 4 / BRO-1630 RC3): does the workspace's rootPath
   *  still exist on disk? A vanished directory (deleted out-of-band, an unmounted
   *  volume) is a live property of the filesystem, so it is COMPUTED here rather
   *  than persisted (a transient unmount self-heals when it returns — no stale
   *  flag). The client can render an unavailable workspace distinctly instead of
   *  letting a thread bind one that will error at cwd time. rootPath still never
   *  leaves the server — only the boolean.
   *
   *  `worktreeCapable` (BRO-1657): would a session on this workspace ACTUALLY get
   *  a per-session worktree if it asked for one? Folds the same inputs the B2
   *  decision uses — the per-workspace `noWorktree` (BRO-1512, nested-repo → root)
   *  AND the supervisor global — into one honest client-facing boolean, so the
   *  launcher's root/worktree toggle can offer "worktree" only where it's real
   *  (on a global-`noWorktree` box every workspace reports `false` → the toggle
   *  is forced-root everywhere). A capability flag, not a path — safe to expose. */
  async listWorkspaces(): Promise<
    Array<
      Pick<Workspace, "id" | "name" | "isGitRepo"> & {
        available: boolean;
        worktreeCapable: boolean;
      }
    >
  > {
    await this.ensureWorkspace();
    return [...this.workspaceRegistry.values()].map((w) => ({
      id: w.id,
      name: w.name,
      isGitRepo: w.isGitRepo,
      available: this.workspaceExists(w.rootPath),
      // Mirror the runTurn default: workspace override wins, else the global.
      worktreeCapable: !(w.noWorktree ?? this.noWorktree),
    }));
  }

  /** The workspace a thread binds when none (or an unregistered one) is requested. */
  get defaultWorkspaceId(): string {
    return this.defaultWorkspace.id;
  }

  /** Resolve a registered workspace's SERVER-ONLY `rootPath` by id (BRO-1666, the
   *  fs browser). Returns undefined for an unknown id. This is the ONE place the
   *  rootPath is handed out server-side — the caller (an auth-gated fs route) uses
   *  it purely to sandbox filesystem reads under it and returns only RELATIVE paths
   *  + file contents. The rootPath itself NEVER leaves the engine (unlike
   *  {@link listWorkspaces}, whose public DTO deliberately omits it). Registry-
   *  backed (no Store round-trip); awaits hydration so a first-call before any
   *  dispatch still resolves. */
  async resolveWorkspaceRoot(id: string): Promise<string | undefined> {
    await this.ensureWorkspace();
    return this.workspaceRegistry.get(id)?.rootPath;
  }

  // --- /control (BRO-1493) — resolve threadId → sessionKey, delegate to engine.

  /** The live-session control surface for a thread's bound engine (BRO-1620).
   *  Only the interactive engine has one; the print engine resolves to undefined. */
  private controlFor(session: Session | undefined): EngineControl | undefined {
    return this.controls[session?.engine ?? this.defaultEngine];
  }

  /** Reset a thread's agent session → next turn starts fresh (new
   *  conversation, same workspace). Engine-agnostic (BRO-1524): clearing the
   *  stored agentSessionId means the print engine drops `--resume`; the
   *  interactive engine additionally kills its live process via control.reset. */
  async reset(threadId: string): Promise<ControlResult> {
    const s = await this.store.findSessionByThread(threadId);
    if (s === undefined) return { ok: false, reason: "no-session" };
    // Interactive engine: abort + kill the live session (resolves any in-flight
    // turn as blocked immediately — B1). Print engine: no live process (had=false).
    const ctrl = this.controlFor(s);
    const had = ctrl ? await ctrl.reset(s.id) : false;
    // Wait for any in-flight dispatch on this thread to settle, so its
    // phase/agentSessionId write-back can't clobber our reset (B2 — the racing
    // runTurn finally-writes blocked + the OLD agentSessionId). Re-read after.
    await (this.chains.get(threadId) ?? Promise.resolve()).catch(() => {});
    const fresh = (await this.store.findSessionByThread(threadId)) ?? s;
    fresh.agentSessionId = undefined;
    fresh.phase = "idle";
    await this.store.upsertSession(fresh);
    return { ok: true, phase: "idle", alive: had };
  }

  /** Interrupt the in-flight turn for a thread. */
  async interrupt(threadId: string): Promise<ControlResult> {
    const s = await this.store.findSessionByThread(threadId);
    if (s === undefined) return { ok: false, reason: "no-session" };
    const ctrl = this.controlFor(s);
    if (ctrl === undefined) return { ok: false, reason: "unsupported" };
    const live = await ctrl.interrupt(s.id);
    return { ok: live, reason: live ? undefined : "no-session" };
  }

  /** Live state for a thread (phase from the store, liveness from the engine). */
  async status(threadId: string): Promise<ControlResult> {
    const s = await this.store.findSessionByThread(threadId);
    if (s === undefined) return { ok: false, reason: "no-session" };
    const ctrl = this.controlFor(s);
    const st = ctrl ? await ctrl.status(s.id) : { alive: false };
    return { ok: true, phase: s.phase, alive: st.alive, sessionId: st.sessionId };
  }

  // --- Session management (BRO-1592) — archive / rename / delete.

  /** Soft-archive (hide from the default drawer list) or restore a thread. A
   *  no-op-safe toggle; reversible. Serialized on the thread chain so it runs
   *  AFTER any in-flight turn — its write can't be clobbered by runTurn's
   *  end-of-turn full-session upsert (which carries the archived/title columns). */
  archiveThread(threadId: string, archived: boolean): Promise<ControlResult> {
    return this.enqueue(threadId, async () => {
      const s = await this.store.findSessionByThread(threadId);
      if (s === undefined) return { ok: false, reason: "no-session" };
      s.archived = archived;
      await this.store.upsertSession(s);
      return { ok: true, phase: s.phase };
    });
  }

  /** Rename a thread (BRO-1592). Empty title clears it → the drawer falls back
   *  to the last-text preview. Serialized on the thread chain (see archiveThread). */
  setTitle(threadId: string, title: string): Promise<ControlResult> {
    return this.enqueue(threadId, async () => {
      const s = await this.store.findSessionByThread(threadId);
      if (s === undefined) return { ok: false, reason: "no-session" };
      s.title = title.trim() || undefined;
      await this.store.upsertSession(s);
      return { ok: true, phase: s.phase };
    });
  }

  /** Hard-delete a thread and its transcript (BRO-1592). Kill any live engine
   *  session FIRST (so the aborting turn settles fast), then serialize the delete
   *  on the thread chain so it runs AFTER the in-flight turn drains — no phase
   *  write-back can resurrect the row, and we never evict a newer enqueue's chain
   *  entry. Irreversible. */
  deleteThread(threadId: string): Promise<ControlResult> {
    return this.store.findSessionByThread(threadId).then(async (s0) => {
      if (s0 === undefined) return { ok: false, reason: "no-session" } as ControlResult;
      const ctrl = this.controlFor(s0);
      if (ctrl) await ctrl.reset(s0.id).catch(() => false);
      return this.enqueue(threadId, async () => {
        // Re-resolve in case the thread was recreated while the live turn drained.
        const fresh = await this.store.findSessionByThread(threadId);
        if (fresh) await this.store.deleteSession(fresh.id);
        return { ok: true } as ControlResult;
      });
    });
  }
}
