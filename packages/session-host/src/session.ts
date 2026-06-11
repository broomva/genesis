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
  /** Claude session UUID (default: random). */
  sessionId?: string;
  // NOTE: `resume` was removed (P20 review B2): Claude Code assigns a NEW
  // session_id to resumed sessions, which would silently break per-session
  // routing (hub keys events by session_id). Resume support requires a
  // SessionStart re-keying handshake — tracked as a follow-up.
  /** Extra CLI args appended verbatim. */
  extraArgs?: string[];
  /** Per-session permission policy (overrides hub default). */
  policy?: PermissionPolicy;
  /** Raw PTY byte sink for the render-only fallback view. */
  rawSinkPath?: string;
  /** Extra environment variables for the session process. */
  env?: Record<string, string>;
  actuator?: InputActuator;
}

/** Resolve a pinned Claude Code binary; throws when the pin is absent. */
export function resolveClaudeBinary(pin?: string, explicit?: string): string {
  if (explicit !== undefined) return explicit;
  if (pin !== undefined) {
    const pinned = join(homedir(), ".local", "share", "claude", "versions", pin);
    if (!existsSync(pinned)) {
      throw new Error(`pinned claude ${pin} not found at ${pinned} — run: claude install ${pin}`);
    }
    return pinned;
  }
  return "claude";
}

export class SessionHub {
  private readonly control: ControlServer;
  private readonly sessions = new Map<string, SessionHost>();
  private readonly listeners = new Set<(event: IREvent) => void>();
  private readonly defaultPolicy?: PermissionPolicy;

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
    this.sessions.get(event.sessionId)?.ingest(event);
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

  constructor(hub: SessionHub, sessionId: string, opts: CreateSessionOptions) {
    this.hub = hub;
    this.sessionId = sessionId;
    this.opts = opts;
    this.policy = opts.policy;
    this.actuator = opts.actuator ?? new TmuxActuator();
    this.adapter = new ClaudeCodeAdapter({ sessionId });
    this.tmuxName = `gen-${sessionId.slice(0, 8)}`;
  }

  get drift() {
    return this.adapter.drift;
  }

  async spawn(socketPath: string): Promise<void> {
    const bin = resolveClaudeBinary(this.opts.pin, this.opts.bin);
    const settings = JSON.stringify(buildSessionSettings({ socketPath }));
    const argv: string[] = ["--session-id", this.sessionId, "--settings", settings];
    if (this.opts.extraArgs) argv.push(...this.opts.extraArgs);
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

  /** Type a user turn into the session. */
  async send(text: string): Promise<void> {
    await this.actuator.send(this.tmuxName, text);
  }

  /** Interrupt the in-flight turn (Escape). */
  async interrupt(): Promise<void> {
    await this.actuator.interrupt(this.tmuxName);
  }

  async alive(): Promise<boolean> {
    return this.actuator.alive(this.tmuxName);
  }

  async kill(): Promise<void> {
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

  /** @internal — hub routes this session's hook/status events here. */
  ingest(event: IREvent): void {
    if (event.kind === "session.lifecycle" && event.transcriptPath !== undefined) {
      // Contract surface: transcript path from hook input, never reconstructed.
      void this.attachTranscript(event.transcriptPath);
    }
  }
}
