// Supervisor — the control plane. resolve(threadId) → Session, then
// dispatch(text) → run the agent → project NDJSON → record turns → reply.
// The runner is injected so the supervisor is unit-testable without a live CLI.
//
// Dispatches are serialized PER THREAD (F19): the default channel uses a
// constant thread id, so two near-simultaneous messages on one session would
// otherwise stomp each other's phase + agentSessionId (corrupting --resume).
// The store is async (Phase 2) so a durable Drizzle/Postgres backend can be
// swapped in behind the same Supervisor — sessions survive a restart.

import {
  type ExecutionHost,
  type HostProvider,
  LocalHost,
  StaticHostProvider,
} from "@genesis/host";
import type { AgentEvent, RunState } from "@genesis/projection";
import {
  type EffortLevel,
  type RunOptions,
  type RunResult,
  removeWorktree,
  runAgent,
} from "@genesis/runner";
import { InMemoryStore, type Store, isoNow, newId } from "./store";
import type { Session, TokenUsage, Turn, Workspace } from "./types";

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
   *  Unknown/unregistered → the default workspace. Sticky, mirrors `engine`. */
  workspaceId?: string;
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
   *  (GENESIS_PROJECTS_ROOT scan + GENESIS_WORKSPACES override). Merged after the
   *  default (later entries win on id collision). A new thread can bind any of
   *  these via TurnOptions.workspaceId; the binding is sticky at session create. */
  workspaces?: Workspace[];
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
  /** Per-event observability tap (BRO-1524): every AgentEvent of every turn,
   *  tagged with the session id. The boot wires this for ALL turns now that both
   *  engines coexist (BRO-1620) — interactive turns get both this AgentEvent trace
   *  (a distinct *.events.jsonl file) and the engine's richer IR observer. */
  trace?: (sessionId: string, event: AgentEvent) => void;
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

export class Supervisor {
  private readonly store: Store;
  private readonly runners: Record<string, RunnerFn>;
  private readonly controls: Record<string, EngineControl>;
  private readonly defaultEngine: string;
  private readonly trace?: (sessionId: string, event: AgentEvent) => void;
  private readonly hostProvider: HostProvider;
  private readonly extraArgs?: string[];
  private readonly remoteCwd?: string;
  private readonly noWorktree: boolean;
  private readonly defaultWorkspace: Workspace;
  /** id → Workspace, the selectable registry (BRO-1627). Default first, then the
   *  boot-discovered set (later entries win). Holds the richer registry-only
   *  fields (noWorktree/isGitRepo) that never round-trip through the DB. */
  private readonly workspaceRegistry: Map<string, Workspace>;
  /** Per-thread promise chain — serializes dispatches on the same session. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Memoized one-shot persistence of the workspace registry (async ctor work). */
  private workspaceEnsured?: Promise<void>;

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
    this.trace = cfg.trace;
    this.hostProvider =
      cfg.hostProvider ?? new StaticHostProvider(cfg.host ?? new LocalHost(), cfg.remoteCwd);
    this.extraArgs = cfg.extraArgs;
    this.remoteCwd = cfg.remoteCwd;
    this.noWorktree = cfg.noWorktree ?? false;
    this.defaultWorkspace = cfg.defaultWorkspace;
    // Build the selectable registry (BRO-1627): default first, then the
    // boot-discovered workspaces (a later entry with the same id wins, so an
    // explicit GENESIS_WORKSPACES entry can override a scanned one).
    this.workspaceRegistry = new Map();
    for (const w of [cfg.defaultWorkspace, ...(cfg.workspaces ?? [])]) {
      this.workspaceRegistry.set(w.id, w);
    }
  }

  private ensureWorkspace(): Promise<void> {
    // Persist the WHOLE registry (BRO-1627), idempotently, so resolve→getWorkspace
    // keeps working and a bound thread survives the workspace being deconfigured
    // later (the DB retains the row). Clear the memo on rejection so a transient
    // first-dispatch failure (e.g. a Postgres connect blip) doesn't poison every
    // later dispatch (P20 #1).
    this.workspaceEnsured ??= Promise.all(
      [...this.workspaceRegistry.values()].map((w) => this.store.upsertWorkspace(w)),
    )
      .then(() => {})
      .catch((e) => {
        this.workspaceEnsured = undefined;
        throw e;
      });
    return this.workspaceEnsured;
  }

  /** chat-id/thread → Session. A NEW thread binds the requested workspace (BRO-1627)
   *  if it's registered, else the default; an existing thread is returned unchanged
   *  (the binding is sticky from session creation — switching = a new thread). */
  async resolve(threadId: string, workspaceId?: string): Promise<Session> {
    await this.ensureWorkspace();
    const existing = await this.store.findSessionByThread(threadId);
    if (existing) return existing;
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
    const session = await this.resolve(threadId, turnOpts?.workspaceId);
    // Resolve the bound workspace registry-FIRST (BRO-1627) — the registry carries
    // the richer noWorktree/isGitRepo the DB row doesn't. If it's fully deconfigured
    // AND the thread already ran there, do NOT silently re-cwd into the default tree:
    // that would corrupt --resume continuity. Surface an error instead (§edge-cases).
    const known =
      this.workspaceRegistry.get(session.workspaceId) ??
      (await this.store.getWorkspace(session.workspaceId));
    if (!known && session.agentSessionId !== undefined) {
      throw new Error(
        `This thread's workspace (${session.workspaceId}) is no longer available; it can't be resumed elsewhere. Start a new thread to pick a workspace.`,
      );
    }
    const workspace = known ?? this.defaultWorkspace;
    // Per-workspace worktree posture wins over the supervisor global (BRO-1512):
    // a nested-monorepo workspace runs direct; a single-repo one may worktree.
    const noWorktree = workspace.noWorktree ?? this.noWorktree;
    await this.store.addTurn({ sessionId: session.id, role: "user", text });

    // Derive a thread title from the first user turn (BRO-1592) — persisted with
    // the phase write below, so the drawer shows a stable label instead of a
    // running last-text preview. Never overwrites a title once set (or renamed).
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
      const result = await run({
        prompt: text,
        cwd: workspace.rootPath,
        resumeSessionId: session.agentSessionId,
        host: lease.host,
        extraArgs: this.extraArgs,
        // Per-turn model/effort (BRO-1573) override the constructor defaults.
        model: turnOpts?.model,
        effort: turnOpts?.effort,
        remoteCwd: lease.remoteCwd ?? this.remoteCwd,
        // Stable per-session worktree → reused across turns so claude --resume
        // finds its cwd-scoped session (multi-turn continuity on LocalHost).
        // noWorktree → run directly in the workspace (BRO-1512: nested-repo cwd).
        sessionKey: session.id,
        worktree: noWorktree ? false : undefined,
        onState: (state, event) => {
          session.phase = state.phase;
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
  }

  async history(threadId: string): Promise<Turn[]> {
    const s = await this.store.findSessionByThread(threadId);
    return s ? this.store.turnsForSession(s.id) : [];
  }

  /** Every thread, newest-first, for the PWA thread drawer (BRO-1567). Reads the
   *  last turn per session for a preview — N+1 over sessions, fine at single-user
   *  scale (one owner, a handful of threads); revisit with a JOIN if it grows. */
  async listThreads(): Promise<ThreadSummary[]> {
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

  /** The selectable workspaces (BRO-1627), default first. The api advertises
   *  these via GET /workspaces so the client can offer a per-thread picker;
   *  registry-backed (no Store round-trip — the live set is in memory). */
  listWorkspaces(): Workspace[] {
    return [...this.workspaceRegistry.values()];
  }

  /** The workspace a thread binds when none (or an unregistered one) is requested. */
  get defaultWorkspaceId(): string {
    return this.defaultWorkspace.id;
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
