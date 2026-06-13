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
import { type RunOptions, type RunResult, removeWorktree, runAgent } from "@genesis/runner";
import { InMemoryStore, type Store, isoNow, newId } from "./store";
import type { Session, Turn, Workspace } from "./types";

export type RunnerFn = (opts: RunOptions) => Promise<RunResult>;

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
  /** Default workspace every new thread binds to (Phase 1: one workspace). */
  defaultWorkspace: Workspace;
  /** Resolves an ExecutionHost per session (e.g. a per-session microVM). When
   *  omitted, a StaticHostProvider wraps `host` (or a LocalHost). */
  hostProvider?: HostProvider;
  /** Shorthand for a single shared host (wrapped in a StaticHostProvider). */
  host?: ExecutionHost;
  run?: RunnerFn;
  /** Live-session control surface (interactive engine). Enables /control
   *  (reset/interrupt/status). Omit → those ops report "unsupported". */
  control?: EngineControl;
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
}

export class Supervisor {
  private readonly store: Store;
  private readonly run: RunnerFn;
  private readonly control?: EngineControl;
  private readonly hostProvider: HostProvider;
  private readonly extraArgs?: string[];
  private readonly remoteCwd?: string;
  private readonly noWorktree: boolean;
  private readonly defaultWorkspace: Workspace;
  /** Per-thread promise chain — serializes dispatches on the same session. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Memoized one-shot persistence of the default workspace (async ctor work). */
  private workspaceEnsured?: Promise<void>;

  constructor(cfg: SupervisorConfig) {
    this.store = cfg.store ?? new InMemoryStore();
    this.run = cfg.run ?? runAgent;
    this.control = cfg.control;
    this.hostProvider =
      cfg.hostProvider ?? new StaticHostProvider(cfg.host ?? new LocalHost(), cfg.remoteCwd);
    this.extraArgs = cfg.extraArgs;
    this.remoteCwd = cfg.remoteCwd;
    this.noWorktree = cfg.noWorktree ?? false;
    this.defaultWorkspace = cfg.defaultWorkspace;
  }

  private ensureWorkspace(): Promise<void> {
    // Clear the memo on rejection so a transient first-dispatch failure (e.g. a
    // Postgres connect blip) doesn't poison every later dispatch (P20 #1).
    this.workspaceEnsured ??= this.store
      .upsertWorkspace(this.defaultWorkspace)
      .then(() => {})
      .catch((e) => {
        this.workspaceEnsured = undefined;
        throw e;
      });
    return this.workspaceEnsured;
  }

  /** chat-id/thread → Session (created + bound to the default workspace if new). */
  async resolve(threadId: string): Promise<Session> {
    await this.ensureWorkspace();
    const existing = await this.store.findSessionByThread(threadId);
    if (existing) return existing;
    return this.store.upsertSession({
      id: newId("sess"),
      workspaceId: this.defaultWorkspace.id,
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
  ): Promise<DispatchResult> {
    const prev = this.chains.get(threadId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.runTurn(threadId, text, onState));
    const guarded = next.catch(() => {});
    this.chains.set(threadId, guarded);
    // Compare-and-delete once this turn settles, unless a newer dispatch replaced
    // it — keeps the per-thread chain map from growing unbounded (P20 round-2 LOW).
    void guarded.then(() => {
      if (this.chains.get(threadId) === guarded) this.chains.delete(threadId);
    });
    return next;
  }

  private async runTurn(
    threadId: string,
    text: string,
    onState?: (state: RunState, event: AgentEvent) => void,
  ): Promise<DispatchResult> {
    const session = await this.resolve(threadId);
    const workspace = (await this.store.getWorkspace(session.workspaceId)) ?? this.defaultWorkspace;
    await this.store.addTurn({ sessionId: session.id, role: "user", text });

    session.phase = "running";
    await this.store.upsertSession(session);

    // Lease a host for THIS session (e.g. its own per-session microVM).
    const lease = await this.hostProvider.resolveHost({ id: session.id, threadId });
    try {
      const result = await this.run({
        prompt: text,
        cwd: workspace.rootPath,
        resumeSessionId: session.agentSessionId,
        host: lease.host,
        extraArgs: this.extraArgs,
        remoteCwd: lease.remoteCwd ?? this.remoteCwd,
        // Stable per-session worktree → reused across turns so claude --resume
        // finds its cwd-scoped session (multi-turn continuity on LocalHost).
        // noWorktree → run directly in the workspace (BRO-1512: nested-repo cwd).
        sessionKey: session.id,
        worktree: this.noWorktree ? false : undefined,
        onState: (state, event) => {
          session.phase = state.phase;
          onState?.(state, event);
        },
      });

      if (result.state.sessionId) session.agentSessionId = result.state.sessionId;
      session.phase = result.state.phase;
      await this.store.upsertSession(session);

      const reply = result.state.lastText ?? "(no output)";
      await this.store.addTurn({ sessionId: session.id, role: "agent", text: reply });

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

      return { session, reply, phase: result.state.phase };
    } finally {
      await lease.release?.().catch((e) => console.error(`[genesis] host release failed: ${e}`));
    }
  }

  async history(threadId: string): Promise<Turn[]> {
    const s = await this.store.findSessionByThread(threadId);
    return s ? this.store.turnsForSession(s.id) : [];
  }

  // --- /control (BRO-1493) — resolve threadId → sessionKey, delegate to engine.

  /** Reset a thread's agent session: drop the live process (next turn spawns
   *  fresh = new conversation, same workspace) and clear stored continuity. */
  async reset(threadId: string): Promise<ControlResult> {
    if (this.control === undefined) return { ok: false, reason: "unsupported" };
    const s = await this.store.findSessionByThread(threadId);
    if (s === undefined) return { ok: false, reason: "no-session" };
    // Abort + kill the live session (engine resolves any in-flight turn as
    // blocked immediately — B1).
    const had = await this.control.reset(s.id);
    // Then wait for any in-flight dispatch on this thread to settle, so its
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
    if (this.control === undefined) return { ok: false, reason: "unsupported" };
    const s = await this.store.findSessionByThread(threadId);
    if (s === undefined) return { ok: false, reason: "no-session" };
    const live = await this.control.interrupt(s.id);
    return { ok: live, reason: live ? undefined : "no-session" };
  }

  /** Live state for a thread (phase from the store, liveness from the engine). */
  async status(threadId: string): Promise<ControlResult> {
    const s = await this.store.findSessionByThread(threadId);
    if (s === undefined) return { ok: false, reason: "no-session" };
    const st = this.control ? await this.control.status(s.id) : { alive: false };
    return { ok: true, phase: s.phase, alive: st.alive, sessionId: st.sessionId };
  }
}
