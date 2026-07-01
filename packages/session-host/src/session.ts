// SessionHub + SessionHost — composition root of the contract-first wrap.
//
//   SessionHub ── ControlServer (one unix socket, all sessions' hooks)
//        │
//        ├── SessionHost A ── TmuxActuator (input) + TranscriptTailer (content)
//        ├── SessionHost B ── …
//        └── firehose onEvent(cb) — every IR event, tagged by sessionId
//
// Observation comes from contract surfaces (hooks, statusline, transcript);
// actuation is isolated in the actuator. The transcript path is learned from
// the SessionStart hook payload — never reconstructed.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type InputActuator, TmuxActuator } from "./actuator";
import { ClaudeCodeAdapter } from "./adapter";
import { ControlServer, type PermissionDecision, type PermissionPolicy } from "./control";
import { buildSessionSettings } from "./hookshim";
import type { IREvent } from "./ir";
import { TranscriptTailer } from "./tailer";

// Re-exported for convenience of hub consumers.
export type { PermissionPolicy } from "./control";

export interface SessionHubOptions {
  socketPath: string;
  /** Default policy applied when a session has none of its own. */
  policy?: PermissionPolicy;
}

export interface CreateSessionOptions {
  /** Working directory for the session (a repo or worktree). */
  cwd: string;
  /** Pinned CLI version (e.g. "2.1.173") resolved under
   *  ~/.local/share/claude/versions; falls back to `bin` or PATH "claude". */
  pin?: string;
  /** Explicit binary path (overrides pin). */
  bin?: string;
  /** Initial prompt (positional — interactive mode, never `-p`). */
  initialPrompt?: string;
  /** Claude session UUID (default: random). Doubles as the resume target when
   *  `resume` is set. */
  sessionId?: string;
  /** Resume the conversation identified by `sessionId` — spawn `--resume
   *  <sessionId>` INSTEAD of `--session-id <sessionId>` (BRO-1630). Re-verified
   *  live on CLI 2.1.191: `claude --resume <id>` (no `--fork-session`) keeps the
   *  SAME session_id and APPENDS to the same `<id>.jsonl` (no new file, no
   *  re-key) — so the hub's per-session hook routing (keyed on session_id) stays
   *  valid with no handshake. This retires the stale P20-B2 concern that resume
   *  reassigned the id (true on the ~2026-06 CLI, no longer). `--session-id` and
   *  `--resume` are MUTUALLY EXCLUSIVE without `--fork-session` (the CLI errors),
   *  so resume replaces it. The caller ensures the transcript for `sessionId`
   *  exists under `cwd` (else claude has nothing to resume — spawn fresh instead). */
  resume?: boolean;
  /** Extra CLI args appended verbatim. */
  extraArgs?: string[];
  /** Per-session permission policy (overrides hub default). */
  policy?: PermissionPolicy;
  /** Raw PTY byte sink for the render-only fallback view. */
  rawSinkPath?: string;
  /** Extra environment variables for the session process. */
  env?: Record<string, string>;
  actuator?: InputActuator;
  /** Closed-loop send: ms to wait for the UserPromptSubmit ack (default 5000). */
  submitAckMs?: number;
  /** Closed-loop send: clear+retype retries after a missed ack (default 2). */
  submitRetries?: number;
}

/** Resolve a Claude Code binary: explicit > pinned-if-present > PATH `claude`.
 *  A missing pin degrades to PATH (warns) rather than throwing (BRO-1494). */
export function resolveClaudeBinary(pin?: string, explicit?: string): string {
  if (explicit !== undefined) return explicit;
  if (pin !== undefined) {
    const pinned = join(homedir(), ".local", "share", "claude", "versions", pin);
    if (existsSync(pinned)) return pinned;
    // Graceful fallback (BRO-1494): Claude Code's auto-updater garbage-collects
    // old versions, so a pin can vanish out from under a long-running daemon —
    // which previously hard-failed EVERY turn. Degrade to PATH `claude` (latest)
    // with a loud warning rather than wedging the whole bot.
    console.warn(
      `[genesis] pinned claude ${pin} not found at ${pinned} (auto-updater pruned it?) — falling back to PATH claude. Pin a still-installed version to silence this.`,
    );
    return "claude";
  }
  return "claude";
}

export class SessionHub {
  private readonly control: ControlServer;
  private readonly sessions = new Map<string, SessionHost>();
  private readonly listeners = new Set<(event: IREvent) => void>();
  private readonly defaultPolicy?: PermissionPolicy;
  /** Ids we've already warned about (dedupe the unknown-session alarm). */
  private readonly warnedUnknown = new Set<string>();

  constructor(opts: SessionHubOptions) {
    this.defaultPolicy = opts.policy;
    this.control = new ControlServer({
      socketPath: opts.socketPath,
      onEvent: (event) => this.dispatch(event),
      policy: (request) => {
        const session = this.sessions.get(request.sessionId);
        const policy = session?.policy ?? this.defaultPolicy;
        return policy?.(request);
      },
    });
  }

  start(): void {
    this.control.start();
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) await session.kill();
    this.control.stop();
  }

  /** Firehose across all sessions (multi-session UI feed). */
  onEvent(listener: (event: IREvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolve a held permission request (UI card → decision). */
  respondPermission(requestId: string, decision: PermissionDecision, reason?: string): boolean {
    return this.control.respond(requestId, decision, reason);
  }

  pendingPermissions() {
    return this.control.pendingRequests();
  }

  session(sessionId: string): SessionHost | undefined {
    return this.sessions.get(sessionId);
  }

  async createSession(opts: CreateSessionOptions): Promise<SessionHost> {
    const sessionId = opts.sessionId ?? randomUUID();
    const host = new SessionHost(this, sessionId, opts);
    this.sessions.set(sessionId, host);
    await host.spawn(this.control.socketPath);
    return host;
  }

  /** @internal */
  dispatch(event: IREvent): void {
    const host = this.sessions.get(event.sessionId);
    // Resume-reversion alarm (BRO-1630 P20 finding #1): durable resume assumes
    // `claude --resume <id>` PRESERVES the session id (verified on CLI 2.1.191/197
    // — `--fork-session` is the opt-in that reassigns it). If a future CLI ever
    // reverts to reassigning on resume, hooks would carry an UNKNOWN id, route to
    // no SessionHost, and the turn would hang to timeout with zero events — a
    // SILENT failure. Convert it to a LOUD, greppable diagnostic (once per id) so
    // the regression is diagnosable instead of mysterious. Hooks are per-session
    // and sessions are registered before spawn, so an unknown-session hook is a
    // genuine anomaly, not normal traffic.
    if (
      host === undefined &&
      event.surface === "hook" &&
      !this.warnedUnknown.has(event.sessionId)
    ) {
      this.warnedUnknown.add(event.sessionId);
      console.warn(
        `[genesis] session-host: hook (kind=${event.kind}) for UNKNOWN session ${event.sessionId} — dropped. If this follows a --resume spawn, the CLI may have reassigned the session id (a --fork-session-style regression); durable-resume routing (BRO-1630) assumes it is preserved.`,
      );
    }
    host?.ingest(event);
    for (const listener of this.listeners) listener(event);
  }
}

export class SessionHost {
  readonly sessionId: string;
  readonly policy?: PermissionPolicy;
  private readonly hub: SessionHub;
  private readonly opts: CreateSessionOptions;
  private readonly actuator: InputActuator;
  private readonly adapter: ClaudeCodeAdapter;
  private tailer: TranscriptTailer | undefined;
  private tmuxName: string;
  transcriptPath: string | undefined;
  private readonly submitWaiters = new Set<{
    expected: string;
    timer: ReturnType<typeof setTimeout>;
    resolve: (acked: boolean) => void;
  }>();
  /** Serializes send() per session — a keystroke session has ONE composer, so
   *  two concurrent sends would interleave text + cross-resolve acks. The
   *  engine already serializes per thread, but SessionHost is a public surface
   *  (dev-client, future callers) with no such guarantee (P20 review). */
  private sendChain: Promise<void> = Promise.resolve();
  private readonly submitAckMs: number;
  private readonly submitRetries: number;

  constructor(hub: SessionHub, sessionId: string, opts: CreateSessionOptions) {
    this.hub = hub;
    this.sessionId = sessionId;
    this.opts = opts;
    this.policy = opts.policy;
    this.actuator = opts.actuator ?? new TmuxActuator();
    this.adapter = new ClaudeCodeAdapter({ sessionId });
    this.tmuxName = `gen-${sessionId.slice(0, 8)}`;
    this.submitAckMs = opts.submitAckMs ?? 5_000;
    this.submitRetries = opts.submitRetries ?? 2;
  }

  get drift() {
    return this.adapter.drift;
  }

  async spawn(socketPath: string): Promise<void> {
    const bin = resolveClaudeBinary(this.opts.pin, this.opts.bin);
    const settings = JSON.stringify(buildSessionSettings({ socketPath }));
    // Resume vs fresh (BRO-1630): `--resume <id>` reloads the prior conversation
    // AND keeps the same session_id on CLI 2.1.191 (verified — appends to the same
    // <id>.jsonl), so hook routing is unaffected. `--session-id` and `--resume` are
    // mutually exclusive without `--fork-session`, so a resume spawn omits the
    // former. A fresh spawn pins the id via `--session-id` as before.
    const argv: string[] = this.opts.resume
      ? ["--resume", this.sessionId, "--settings", settings]
      : ["--session-id", this.sessionId, "--settings", settings];
    if (this.opts.extraArgs) argv.push(...this.opts.extraArgs);
    // Always-on summarized extended thinking (BRO-1614) — parity with the print
    // engine. Pushed AFTER extraArgs so the always-on guarantee can't be silently
    // disabled by an operator --thinking* in extraArgs (claude is last-wins).
    // Opus 4.8 / Fable 5 default `thinking.display` to "omitted" (empty thinking);
    // these HIDDEN flags opt back into the summarized trace, which the transcript
    // adapter reads (`adapter.ts` `thinking` block) and the IR maps to a
    // thinking_delta. Adaptive thinking is content-dependent (trivial turns produce
    // none, by design). A/B-verified on the spawned `claude` binary.
    argv.push("--thinking", "adaptive", "--thinking-display", "summarized");
    // Positional prompt LAST; never `-p` (interactive mode is the product).
    if (this.opts.initialPrompt !== undefined) argv.push(this.opts.initialPrompt);

    await this.actuator.spawn({
      name: this.tmuxName,
      bin,
      argv,
      cwd: this.opts.cwd,
      rawSinkPath: this.opts.rawSinkPath,
      env: {
        DISABLE_AUTOUPDATER: "1",
        ...this.opts.env,
      },
    });
    this.hub.dispatch({
      kind: "session.lifecycle",
      sessionId: this.sessionId,
      observedAt: Date.now(),
      surface: "actuator",
      phase: "spawned",
    });
  }

  /**
   * Type a user turn into the session — CLOSED-LOOP (BRO-1485 #9).
   *
   * Pure keystroke actuation is the one open-loop edge in the stack: typing
   * too close to the previous turn's TUI tail can eat the trailing Enter,
   * leaving the prompt unsubmitted in the composer (observed live via
   * Telegram, 2026-06-12 — the dispatch then hangs to the turn timeout,
   * which kills the session). The fix uses the contract surface we already
   * have: the UserPromptSubmit hook fires iff a prompt ACTUALLY submits, so
   * it is the actuator's ack. Type + submit → await the ack → on miss, CLEAR
   * the composer (Escape + Ctrl-U) and retype + submit → bounded retries →
   * throw. (Bare-Enter retry was insufficient — a wedged composer needs the
   * clear+retype, diagnosed live 2026-06-13, BRO-1494.)
   *
   * Empty text (the trust-dialog nudge) stays fire-and-forget: a bare submit
   * on an empty composer never fires UserPromptSubmit.
   */
  async send(text: string): Promise<void> {
    // Serialize against any in-flight send on this session (one composer).
    const run = this.sendChain.then(() => this.sendOnce(text));
    // Keep the chain alive regardless of this send's outcome.
    this.sendChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private async sendOnce(text: string): Promise<void> {
    if (text.length === 0) {
      await this.actuator.send(this.tmuxName, "");
      return;
    }
    const attempts = this.submitRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const ack = this.nextSubmit(this.submitAckMs, text);
      // Attempt 0: type + submit. Retries: CLEAR the composer + retype + submit
      // — a wedged composer (text present, un-submittable) doesn't recover from
      // a bare Enter, but does from clear-then-retype (diagnosed live, BRO-1494).
      await this.actuator.send(this.tmuxName, text, { clearFirst: attempt > 0 });
      if (await ack) return;
    }
    throw new Error(
      `send() not acknowledged by UserPromptSubmit after ${attempts} attempts (session ${this.sessionId})`,
    );
  }

  /** One-shot waiter for the next hook-surface submit of EXACTLY this text.
   *  Text-matching prevents false acks (concurrent sends, late acks from a
   *  prior exhausted send, truncated-text submits) — P20 c.1. */
  private nextSubmit(timeoutMs: number, expected: string): Promise<boolean> {
    return new Promise((resolve) => {
      const entry = {
        expected,
        resolve,
        // The arrow runs later — `entry` is fully defined by then.
        timer: setTimeout(() => {
          this.submitWaiters.delete(entry);
          resolve(false);
        }, timeoutMs),
      };
      this.submitWaiters.add(entry);
    });
  }

  /** Resolve any waiter whose expected text matches this submitted prompt. */
  private ackSubmit(text: string): void {
    for (const w of [...this.submitWaiters]) {
      if (w.expected !== text) continue; // not our submission — keep waiting
      clearTimeout(w.timer);
      this.submitWaiters.delete(w);
      w.resolve(true);
    }
  }

  /** Interrupt the in-flight turn (Escape). */
  async interrupt(): Promise<void> {
    await this.actuator.interrupt(this.tmuxName);
  }

  async alive(): Promise<boolean> {
    return this.actuator.alive(this.tmuxName);
  }

  async kill(): Promise<void> {
    for (const w of [...this.submitWaiters]) {
      clearTimeout(w.timer);
      this.submitWaiters.delete(w);
      w.resolve(false);
    }
    this.tailer?.stop();
    if (await this.actuator.alive(this.tmuxName)) {
      await this.actuator.kill(this.tmuxName);
    }
  }

  /**
   * Attach the content plane to an already-known transcript (daemon-restart
   * recovery: replay snapshot from offset 0, then live-tail).
   */
  async attachTranscript(path: string): Promise<void> {
    if (this.tailer !== undefined && this.transcriptPath === path) return;
    this.tailer?.stop();
    this.transcriptPath = path;
    this.tailer = new TranscriptTailer({
      path,
      onLine: (line) => {
        for (const event of this.adapter.lineToEvents(line)) this.hub.dispatch(event);
      },
    });
    await this.tailer.start();
  }

  /** Flush the transcript tailer to EOF (BRO-1616). The Stop hook that fires
   *  `turn.complete` outpaces the async tailer, so the final assistant message's
   *  extended-thinking (transcript-only — hooks don't carry thinking blocks)
   *  would otherwise be dropped. The engine awaits this before finalizing a turn.
   *  No-op if no transcript is attached. */
  async drainTranscript(): Promise<void> {
    await this.tailer?.flush();
  }

  /** @internal — hub routes this session's hook/status events here. */
  ingest(event: IREvent): void {
    if (event.kind === "session.lifecycle" && event.transcriptPath !== undefined) {
      // Contract surface: transcript path from hook input, never reconstructed.
      void this.attachTranscript(event.transcriptPath);
    }
    // Submit ack (closed-loop send): a hook-surface user message means the
    // composer actually submitted (UserPromptSubmit contract).
    if (event.kind === "message.user" && event.surface === "hook") {
      this.ackSubmit(event.text);
    }
  }
}
