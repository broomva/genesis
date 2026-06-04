// Supervisor — the control plane. resolve(threadId) → Session, then
// dispatch(text) → run the agent → project NDJSON → record turns → reply.
// The runner is injected so the supervisor is unit-testable without a live CLI.

import type { ExecutionHost } from "@genesis/host";
import type { AgentEvent, RunState } from "@genesis/projection";
import { type RunOptions, type RunResult, cleanupWorktree, runAgent } from "@genesis/runner";
import { InMemoryStore, type Store, isoNow, newId } from "./store";
import type { Session, Workspace } from "./types";

export type RunnerFn = (opts: RunOptions) => Promise<RunResult>;

export interface SupervisorConfig {
  store?: Store;
  /** Default workspace every new thread binds to (Phase 1: one workspace). */
  defaultWorkspace: Workspace;
  host?: ExecutionHost;
  run?: RunnerFn;
  /** Extra agent CLI flags applied to every run (e.g. permission mode). */
  extraArgs?: string[];
}

export interface DispatchResult {
  session: Session;
  reply: string;
  phase: RunState["phase"];
}

export class Supervisor {
  private readonly store: Store;
  private readonly run: RunnerFn;
  private readonly host?: ExecutionHost;
  private readonly defaultWorkspace: Workspace;
  private readonly extraArgs?: string[];

  constructor(cfg: SupervisorConfig) {
    this.store = cfg.store ?? new InMemoryStore();
    this.run = cfg.run ?? runAgent;
    this.host = cfg.host;
    this.extraArgs = cfg.extraArgs;
    this.defaultWorkspace = this.store.upsertWorkspace(cfg.defaultWorkspace);
  }

  /** chat-id/thread → Session (created + bound to the default workspace if new). */
  resolve(threadId: string): Session {
    const existing = this.store.findSessionByThread(threadId);
    if (existing) return existing;
    return this.store.upsertSession({
      id: newId("sess"),
      workspaceId: this.defaultWorkspace.id,
      threadId,
      phase: "done",
      createdAt: isoNow(),
    });
  }

  /** Run one turn: dispatch text to the agent, project, record, reply. */
  async dispatch(
    threadId: string,
    text: string,
    onState?: (state: RunState, event: AgentEvent) => void,
  ): Promise<DispatchResult> {
    const session = this.resolve(threadId);
    const workspace = this.store.getWorkspace(session.workspaceId) ?? this.defaultWorkspace;
    this.store.addTurn({ sessionId: session.id, role: "user", text });

    session.phase = "running";
    this.store.upsertSession(session);

    const result = await this.run({
      prompt: text,
      cwd: workspace.rootPath,
      resumeSessionId: session.agentSessionId,
      host: this.host,
      extraArgs: this.extraArgs,
      onState: (state, event) => {
        session.phase = state.phase;
        onState?.(state, event);
      },
    });

    if (result.state.sessionId) session.agentSessionId = result.state.sessionId;
    session.phase = result.state.phase;
    this.store.upsertSession(session);

    const reply = result.state.lastText ?? "(no output)";
    this.store.addTurn({ sessionId: session.id, role: "agent", text: reply });

    // Phase 1: discard the worktree. Phase 2+ merges the branch back.
    if (result.worktreePath) {
      await cleanupWorktree(workspace.rootPath, result.worktreePath, this.host).catch(() => {});
    }

    return { session, reply, phase: result.state.phase };
  }

  history(threadId: string) {
    const s = this.store.findSessionByThread(threadId);
    return s ? this.store.turnsForSession(s.id) : [];
  }
}
