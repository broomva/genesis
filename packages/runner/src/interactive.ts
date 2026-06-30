// Interactive engine — the EXEMPT runner (BRO-1488, Path B).
//
// Where `runAgent` spawns `claude -p … --output-format stream-json` per turn
// (the METERED headless category post-Jun-15), this engine keeps ONE
// persistent INTERACTIVE Claude Code session per Genesis sessionKey via
// @genesis/session-host (positional prompt, never `-p` — the exempt
// subscription class) and feeds later turns into the live process.
//
// Integration trick: IR events are translated into the same `AgentEvent`
// shapes the stream-json parser produces, so the existing projection reducer,
// Supervisor, and /api/chat are untouched — this is just another RunnerFn.
//
// Continuity model: the live process IS the continuity (no `--resume`).
// `resumeSessionId` is acknowledged with a notice and ignored; after a daemon
// restart a fresh agent session starts in the SAME persistent worktree
// (context re-derivable from the repo; full resume re-keying is BRO-1485).

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalHost } from "@genesis/host";
import { type AgentEvent, type RunState, initialState, reduce } from "@genesis/projection";
import type { IREvent, PermissionPolicy } from "@genesis/session-host";
import { SessionHub } from "@genesis/session-host";
import { type RunOptions, type RunResult, ensureSessionWorktree } from "./index";
import { interceptSlashCommand } from "./slash";

/** Minimal hub surface the engine needs — SessionHub satisfies it
 *  structurally; tests inject a scripted fake. */
export interface EngineHub {
  start(): void;
  stop(): Promise<void>;
  onEvent(listener: (event: IREvent) => void): () => void;
  createSession(opts: {
    cwd: string;
    sessionId?: string;
    pin?: string;
    bin?: string;
    initialPrompt?: string;
    extraArgs?: string[];
  }): Promise<EngineSession>;
}

export interface EngineSession {
  sessionId: string;
  send(text: string): Promise<void>;
  /** Interrupt the in-flight turn (Escape). */
  interrupt(): Promise<void>;
  alive(): Promise<boolean>;
  kill(): Promise<void>;
}

export interface InteractiveEngineConfig {
  /** Injected hub (tests). Default: a lazy SessionHub on a per-process socket. */
  hub?: EngineHub;
  socketPath?: string;
  /** Pinned CLI version under ~/.local/share/claude/versions (e.g. "2.1.173"). */
  pin?: string;
  /** Explicit binary path (overrides pin). */
  bin?: string;
  /** Permission policy. Default: allow-all — parity with the print engine's
   *  `--dangerously-skip-permissions` deployments. Inject a real policy when
   *  the permission-card UI lands. */
  policy?: PermissionPolicy;
  /** Per-turn ceiling before the run is marked blocked (default 10 min). */
  turnTimeoutMs?: number;
  /** First-spawn grace before the trust-dialog Enter nudge (default 12s). */
  trustNudgeMs?: number;
  /** Observability tap (BRO-1519): receives EVERY hub IR event PLUS engine
   *  diagnostics for failures the hooks can't surface (send-not-acknowledged,
   *  turn-timeout, reset/interrupt, eviction, spawn). Wire a RunLogger here. */
  observer?: (event: IREvent) => void;
}

interface LiveSession {
  session: EngineSession;
  /** Set once any hook event has been observed (trust dialog passed). */
  hookSeen: boolean;
  /** Abort the in-flight turn (set during a turn, cleared on completion). Lets
   *  reset() resolve a parked run() deterministically instead of leaving it to
   *  hang on turnDone until the turn timeout (P20 BRO-1493 B1). */
  abort?: () => void;
}

/** Live session state for a thread (BRO-1493 /control surface). */
export interface SessionControlStatus {
  /** A live interactive session exists for this key. */
  alive: boolean;
  /** Claude session id, when live. */
  sessionId?: string;
}

export interface InteractiveEngine {
  run: (opts: RunOptions) => Promise<RunResult>;
  /** Kill every live agent session and the hub (SIGTERM path). */
  shutdown: () => Promise<void>;
  /** Reset a thread's session: kill + evict so the NEXT turn spawns fresh
   *  (clears the agent's working context). Returns true if a session existed. */
  reset: (sessionKey: string) => Promise<boolean>;
  /** Interrupt the in-flight turn for a thread (Escape). Returns true if live. */
  interrupt: (sessionKey: string) => Promise<boolean>;
  /** Inspect a thread's live session state. */
  status: (sessionKey: string) => Promise<SessionControlStatus>;
}

export function createInteractiveEngine(cfg: InteractiveEngineConfig = {}): InteractiveEngine {
  let hub: EngineHub | undefined;
  let started = false;
  const live = new Map<string, LiveSession>();

  // Emit an engine diagnostic to the observer (failures the hub can't surface).
  const diag = (sessionId: string, message: string, detail?: unknown): void => {
    cfg.observer?.({
      kind: "error",
      sessionId,
      observedAt: Date.now(),
      surface: "actuator",
      message,
      detail,
    });
  };

  const ensureHub = (): EngineHub => {
    if (hub === undefined) {
      hub =
        cfg.hub ??
        new SessionHub({
          socketPath: cfg.socketPath ?? join(tmpdir(), `genesis-engine-${process.pid}.sock`),
          policy:
            cfg.policy ??
            (() => ({
              decision: "allow" as const,
              reason: "genesis interactive default (parity with skip-permissions print engine)",
            })),
        });
      // Observability tap: every IR event flows to the observer (BRO-1519).
      if (cfg.observer) hub.onEvent(cfg.observer);
    }
    if (!started) {
      hub.start();
      started = true;
    }
    return hub;
  };

  const run = async (opts: RunOptions): Promise<RunResult> => {
    const host = opts.host ?? new LocalHost();
    // Allow-list, not deny-list (CodeRabbit #9-1): a `vps` (or any future
    // remote) host would run worktree git commands remotely while the hub
    // spawns claude LOCALLY — a split-brain cwd. Only "local" is coherent.
    if (host.kind !== "local") {
      throw new Error(
        `interactive engine is local-host only (tmux + local claude); got host kind "${host.kind}" — use the print engine`,
      );
    }
    // Slash-command interception (BRO-1485 #10): built-in TUI commands open an
    // overlay (not an agent turn) and would wedge / corrupt the session if
    // typed. Short-circuit with a chat reply BEFORE touching any session.
    const slashReply = interceptSlashCommand(opts.prompt);
    if (slashReply !== undefined) {
      const sessionId = live.get(opts.sessionKey ?? "")?.session.sessionId ?? randomUUID();
      const state: RunState = { phase: "done", sessionId, lastText: slashReply, turns: 1 };
      // subtype MUST be "success" — the projection reducer treats any other
      // result subtype as errored→blocked (reducer.ts), so a future replay of
      // this synthetic event would silently invert the phase (P20 #2).
      opts.onState?.(state, {
        type: "result",
        subtype: "success",
        session_id: sessionId,
        result: slashReply,
      });
      return {
        state,
        events: [],
        worktreePath: undefined,
        branch: undefined,
        worktreePersistent: !!opts.sessionKey,
        exitCode: 0,
      };
    }

    const engineHub = ensureHub();
    const key = opts.sessionKey ?? `oneshot-${randomUUID().slice(0, 8)}`;

    // Same persistent worktree the print engine uses (shared helper).
    let worktreePath: string | undefined;
    let branch: string | undefined;
    let runCwd = opts.cwd;
    if (opts.worktree !== false) {
      const repo = await host.exec(["git", "rev-parse", "--is-inside-work-tree"], {
        cwd: opts.cwd,
      });
      if (repo.code === 0 && repo.stdout.trim() === "true") {
        ({ worktreePath, branch } = await ensureSessionWorktree(host, opts.cwd, `session-${key}`));
        runCwd = worktreePath;
      }
    }

    // Reuse only a LIVE session; a dead one gets a fresh sessionId (re-spawning
    // an already-used --session-id collides with the on-disk session registry).
    const prior = live.get(key);
    const reuse = prior !== undefined && (await prior.session.alive());
    const sessionId = reuse ? prior.session.sessionId : randomUUID();

    // P20 round-2 #2: only warn on a GENUINE resume attempt (the Supervisor
    // echoes agentSessionId back on every turn ≥2; matching the live session
    // is normal operation, not a resume).
    if (opts.resumeSessionId !== undefined && opts.resumeSessionId !== sessionId) {
      console.warn(
        "[genesis] interactive engine: resumeSessionId ignored — continuity is the live session (resume re-keying: BRO-1485)",
      );
    }

    // Per-turn translation state (events + reducer, exactly like runAgent).
    const events: AgentEvent[] = [];
    let state: RunState = { ...initialState, sessionId };
    const assistantAccum = new Map<string, string>();
    let lastAssistant: string | undefined;
    // Latest cost from the statusline feed (BRO-1613) — folded onto the terminal
    // result so the context meter shows the turn's running cost.
    let lastCostUsd: number | undefined;

    let finish: () => void = () => {};
    const turnDone = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const push = (event: AgentEvent): void => {
      events.push(event);
      state = reduce(state, event);
      opts.onState?.(state, event);
      // HITL (CodeRabbit #9-2): when the reducer gates on a human
      // (AskUserQuestion → "awaiting"), the interactive TUI is showing the
      // question dialog and no Stop hook will fire — the turn must return
      // `awaiting` NOW (print-engine parity), with the session left ALIVE for
      // the answer. Without this, the run hangs to the timeout, which kills
      // the awaiting session.
      if (state.phase === "awaiting") finish();
    };
    push({ type: "system", subtype: "init", session_id: sessionId });

    const entry: LiveSession = reuse
      ? (prior as LiveSession)
      : { session: undefined as unknown as EngineSession, hookSeen: false };

    // Let reset() abort THIS turn deterministically (B1): push a terminal
    // result so the reducer goes blocked, then resolve turnDone. session.kill()
    // emits no IR, so without this the run would hang to the turn timeout.
    let aborted = false;
    entry.abort = () => {
      if (aborted) return;
      aborted = true;
      push({ type: "result", subtype: "reset-aborted", is_error: true, session_id: sessionId });
      finish();
    };

    const unsubscribe = engineHub.onEvent((ir) => {
      if (ir.sessionId !== sessionId) return;
      if (ir.surface === "hook") entry.hookSeen = true;
      // Hook surface only: in TTY-interactive mode it is the sole live content
      // source, and filtering prevents double-emit if a transcript ever
      // persists (sdk parity guard — session-host README, N6).
      switch (ir.kind) {
        case "tool.use":
          if (ir.surface !== "hook") return;
          // Pass the tool id through (BRO-1613) — the projection parts timeline
          // (BRO-1607) keys tool blocks on it; without it tools/per-tool rendering/
          // files-changed/the HITL QuestionCard never build.
          push({
            type: "assistant",
            session_id: sessionId,
            message: {
              role: "assistant",
              content: [{ type: "tool_use", id: ir.toolUseId, name: ir.name, input: ir.input }],
            },
          });
          return;
        case "tool.result":
          if (ir.surface !== "hook") return;
          // tool_use_id matches the result to its tool block; is_error tints it (BRO-1613).
          push({
            type: "user",
            session_id: sessionId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: ir.toolUseId,
                  content: ir.content,
                  is_error: ir.isError,
                },
              ],
            },
          });
          return;
        case "message.assistant": {
          if (ir.surface !== "hook") return;
          const id = ir.messageId ?? "current";
          const acc = (assistantAccum.get(id) ?? "") + ir.text;
          assistantAccum.set(id, acc);
          lastAssistant = acc;
          push({
            type: "assistant",
            session_id: sessionId,
            message: { role: "assistant", content: [{ type: "text", text: acc }] },
          });
          return;
        }
        case "thinking":
          // Extended thinking (BRO-1613) — arrives on the transcript surface, not
          // `hook`. Map to a thinking_delta so the reducer marks `reasoned` +
          // accumulates prose (BRO-1608). May be empty/absent under subscription
          // auth or if the transcript isn't live in tmux; harmless when so.
          if (typeof ir.text !== "string" || ir.text.length === 0) return;
          push({
            type: "stream_event",
            session_id: sessionId,
            event: {
              type: "content_block_delta",
              delta: { type: "thinking_delta", thinking: ir.text },
            },
          });
          return;
        case "status":
          // Statusline feed (BRO-1613) — carries the running cost (no token
          // breakdown; the meter ring-fill stays partial on this engine).
          if (typeof ir.costUsd === "number") lastCostUsd = ir.costUsd;
          return;
        case "turn.complete":
          if (ir.surface !== "hook") return; // terminal kinds are hook-only too
          push({
            type: "result",
            subtype: "success",
            session_id: sessionId,
            result: ir.lastAssistantMessage ?? lastAssistant,
            total_cost_usd: lastCostUsd,
          });
          finish();
          return;
        case "error":
          if (ir.surface !== "hook") return;
          push({
            type: "result",
            subtype: "error",
            is_error: true,
            session_id: sessionId,
          });
          finish();
          return;
        default:
          return; // status / awaiting / permission.* / lifecycle / unknown — not run-state
      }
    });

    // P20 round-2 B1: a timed-out turn leaves the underlying claude process
    // BUSY mid-turn. Reusing it would interleave keystrokes into a live
    // composer and let the stale turn's events (and its eventual Stop) bleed
    // into the NEXT turn's window — silent cross-turn attribution corruption.
    // The deterministic fix: kill + evict, so the next dispatch respawns fresh
    // (with a fresh sessionId, which also makes the stale event filter exact).
    const timeoutMs = cfg.turnTimeoutMs ?? 600_000;
    const turnStart = Date.now();
    const timeout = setTimeout(() => {
      // No hook fires for a hung turn — diagnose explicitly with context.
      diag(sessionId, `turn timed out after ${(timeoutMs / 1000).toFixed(0)}s — killing+evicting`, {
        sessionKey: key,
        elapsedMs: Date.now() - turnStart,
        lastAssistant: lastAssistant?.slice(0, 120),
      });
      push({ type: "result", subtype: "turn-timeout", is_error: true, session_id: sessionId });
      live.delete(key);
      void entry.session?.kill().catch(() => {});
      finish();
    }, timeoutMs);

    // Trust-dialog nudge: a fresh worktree cwd shows the folder-trust prompt
    // before ANY hook fires (no hook surface exists for it). One Enter accepts
    // the default. Armed AFTER the session exists (P20 round-2 #4 — arming at
    // turn start could no-op while a slow spawn is still pending).
    let nudge: ReturnType<typeof setTimeout> | undefined;
    const armNudge = () => {
      nudge = setTimeout(() => {
        if (!entry.hookSeen && entry.session) {
          void entry.session.send("").catch(() => {});
        }
      }, cfg.trustNudgeMs ?? 12_000);
    };

    try {
      if (reuse) {
        try {
          await entry.session.send(opts.prompt);
        } catch (sendError) {
          // P20 (closed-loop send) B1: an unacknowledged send leaves the
          // composer state UNKNOWN — reusing the session would submit a
          // corrupted concatenation next turn. Kill + evict (mirror of the
          // timeout path); the next dispatch respawns fresh.
          live.delete(key);
          void entry.session.kill().catch(() => {});
          push({ type: "result", subtype: "send-failed", is_error: true, session_id: sessionId });
          finish();
          diag(sessionId, `send not acknowledged — session evicted: ${String(sendError)}`, {
            sessionKey: key,
          });
        }
      } else {
        entry.session = await engineHub.createSession({
          cwd: runCwd,
          sessionId,
          pin: cfg.pin,
          bin: cfg.bin,
          initialPrompt: opts.prompt,
          extraArgs: opts.extraArgs,
        });
        live.set(key, entry);
        armNudge();
      }
      await turnDone;
    } finally {
      clearTimeout(timeout);
      if (nudge !== undefined) clearTimeout(nudge);
      unsubscribe();
      entry.abort = undefined; // turn over — no longer abortable
    }

    return {
      state,
      events,
      worktreePath,
      branch,
      // The worktree AND the live process persist across turns — never
      // per-turn cleanup.
      worktreePersistent: true,
      exitCode: state.phase === "blocked" ? 1 : 0,
    };
  };

  const shutdown = async (): Promise<void> => {
    for (const [, { session }] of live) {
      await session.kill().catch(() => {});
    }
    live.clear();
    if (hub && started) await hub.stop();
  };

  // --- /control surface (BRO-1493) — thread session lifecycle ------------

  const reset = async (sessionKey: string): Promise<boolean> => {
    const entry = live.get(sessionKey);
    if (entry === undefined) return false;
    // Abort any in-flight turn FIRST (resolves its parked run() as blocked),
    // then evict + kill — so /new during an active turn doesn't dangle the
    // streaming reply until the turn timeout (P20 BRO-1493 B1).
    entry.abort?.();
    live.delete(sessionKey);
    await entry.session.kill().catch(() => {});
    return true;
  };

  const interrupt = async (sessionKey: string): Promise<boolean> => {
    const entry = live.get(sessionKey);
    if (entry === undefined || !(await entry.session.alive())) return false;
    await entry.session.interrupt();
    return true;
  };

  const status = async (sessionKey: string): Promise<SessionControlStatus> => {
    const entry = live.get(sessionKey);
    if (entry === undefined) return { alive: false };
    const alive = await entry.session.alive();
    return { alive, sessionId: alive ? entry.session.sessionId : undefined };
  };

  return { run, shutdown, reset, interrupt, status };
}
