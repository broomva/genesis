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
}

interface LiveSession {
  session: EngineSession;
  /** Set once any hook event has been observed (trust dialog passed). */
  hookSeen: boolean;
}

export interface InteractiveEngine {
  run: (opts: RunOptions) => Promise<RunResult>;
  /** Kill every live agent session and the hub (SIGTERM path). */
  shutdown: () => Promise<void>;
}

export function createInteractiveEngine(cfg: InteractiveEngineConfig = {}): InteractiveEngine {
  let hub: EngineHub | undefined;
  let started = false;
  const live = new Map<string, LiveSession>();

  const ensureHub = (): EngineHub => {
    hub ??=
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
    if (!started) {
      hub.start();
      started = true;
    }
    return hub;
  };

  const run = async (opts: RunOptions): Promise<RunResult> => {
    const host = opts.host ?? new LocalHost();
    if (host.kind === "microvm") {
      throw new Error(
        "interactive engine is local-host only (tmux + local claude); use the print engine for microVM hosts",
      );
    }
    if (opts.resumeSessionId) {
      console.warn(
        "[genesis] interactive engine: resumeSessionId ignored — continuity is the live session (resume re-keying: BRO-1485)",
      );
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

    // Per-turn translation state (events + reducer, exactly like runAgent).
    const events: AgentEvent[] = [];
    let state: RunState = { ...initialState, sessionId };
    const assistantAccum = new Map<string, string>();
    let lastAssistant: string | undefined;

    const push = (event: AgentEvent): void => {
      events.push(event);
      state = reduce(state, event);
      opts.onState?.(state, event);
    };
    push({ type: "system", subtype: "init", session_id: sessionId });

    let finish: () => void = () => {};
    const turnDone = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const entry: LiveSession = reuse
      ? (prior as LiveSession)
      : { session: undefined as unknown as EngineSession, hookSeen: false };

    const unsubscribe = engineHub.onEvent((ir) => {
      if (ir.sessionId !== sessionId) return;
      if (ir.surface === "hook") entry.hookSeen = true;
      // Hook surface only: in TTY-interactive mode it is the sole live content
      // source, and filtering prevents double-emit if a transcript ever
      // persists (sdk parity guard — session-host README, N6).
      switch (ir.kind) {
        case "tool.use":
          if (ir.surface !== "hook") return;
          push({
            type: "assistant",
            session_id: sessionId,
            message: {
              role: "assistant",
              content: [{ type: "tool_use", name: ir.name, input: ir.input }],
            },
          });
          return;
        case "tool.result":
          if (ir.surface !== "hook") return;
          push({
            type: "user",
            session_id: sessionId,
            message: { role: "user", content: [{ type: "tool_result", content: ir.content }] },
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
        case "turn.complete":
          push({
            type: "result",
            subtype: "success",
            session_id: sessionId,
            result: ir.lastAssistantMessage ?? lastAssistant,
          });
          finish();
          return;
        case "error":
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

    const timeoutMs = cfg.turnTimeoutMs ?? 600_000;
    const timeout = setTimeout(() => {
      push({ type: "result", subtype: "turn-timeout", is_error: true, session_id: sessionId });
      finish();
    }, timeoutMs);

    // Trust-dialog nudge: a fresh worktree cwd shows the folder-trust prompt
    // before ANY hook fires (no hook surface exists for it). One Enter accepts
    // the default. Ported from the session-host live smoke.
    const nudge = setTimeout(() => {
      if (!entry.hookSeen && entry.session) {
        void entry.session.send("").catch(() => {});
      }
    }, cfg.trustNudgeMs ?? 12_000);

    try {
      if (reuse) {
        await entry.session.send(opts.prompt);
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
      }
      await turnDone;
    } finally {
      clearTimeout(timeout);
      clearTimeout(nudge);
      unsubscribe();
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

  return { run, shutdown };
}
