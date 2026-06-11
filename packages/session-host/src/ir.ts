// IR — the typed event protocol for interactive coding-agent sessions.
//
// This is the firewall (stability-ladder pattern, BRO-1475): every consumer —
// UI, transport, projection — depends ONLY on these types. All knowledge of a
// specific CLI version's transcript envelope, hook payload shape, or status
// feed lives in exactly one adapter (`adapter.ts` for Claude Code). A future
// `codex` adapter emits the same IR.
//
// Design invariants:
// - Unknown input is never fatal: it becomes an `unknown` event (passthrough,
//   raw payload preserved) so the semantic view can degrade loudly while the
//   raw view stays complete.
// - Events are block-granular (one per transcript content block), matching
//   the write granularity of the session transcript — the streaming feel.

/** Where an IR event was derived from. */
export type IRSurface = "transcript" | "hook" | "statusline" | "actuator";

interface IRBase {
  /** Claude session UUID this event belongs to. */
  sessionId: string;
  /** Epoch ms when the host observed the event (not when the CLI created it). */
  observedAt: number;
  /** Source surface (stability-ladder rung) the event came from. */
  surface: IRSurface;
}

/** Session process/lifecycle transitions. */
export interface SessionLifecycleEvent extends IRBase {
  kind: "session.lifecycle";
  phase: "spawned" | "ready" | "ended" | "crashed";
  /** Absolute transcript path, when known (from hook input — never reconstructed). */
  transcriptPath?: string;
  detail?: unknown;
}

/** A user turn (prompt) as recorded in the transcript. */
export interface MessageUserEvent extends IRBase {
  kind: "message.user";
  text: string;
  uuid?: string;
}

/** An assistant text block (transcript) or streaming delta (MessageDisplay hook). */
export interface MessageAssistantEvent extends IRBase {
  kind: "message.assistant";
  /** Full block text (transcript surface) or a delta chunk (hook surface). */
  text: string;
  messageId?: string;
  model?: string;
  uuid?: string;
  /** Present for hook-sourced streaming deltas (MessageDisplay): accumulate
   *  deltas per messageId ordered by index until final=true. */
  streaming?: { turnId?: string; index?: number; final?: boolean };
}

/** An assistant thinking block. */
export interface ThinkingEvent extends IRBase {
  kind: "thinking";
  text: string;
  messageId?: string;
  uuid?: string;
}

/** Assistant requested a tool invocation. */
export interface ToolUseEvent extends IRBase {
  kind: "tool.use";
  toolUseId?: string;
  name: string;
  input: unknown;
  messageId?: string;
  uuid?: string;
}

/** Result of a tool invocation. */
export interface ToolResultEvent extends IRBase {
  kind: "tool.result";
  toolUseId?: string;
  content: unknown;
  isError: boolean;
  uuid?: string;
  durationMs?: number;
}

/** The CLI is asking permission for a tool call (PreToolUse hold-open). */
export interface PermissionRequestEvent extends IRBase {
  kind: "permission.request";
  /** Host-assigned id used to respond via SessionHost.respondPermission(). */
  requestId: string;
  toolName: string;
  toolInput: unknown;
  toolUseId?: string;
}

export type PermissionDecision = "allow" | "deny" | "ask";

/** A permission request was resolved (by policy, UI, or timeout fallback). */
export interface PermissionResolvedEvent extends IRBase {
  kind: "permission.resolved";
  requestId: string;
  decision: PermissionDecision;
  reason?: string;
  source: "policy" | "client" | "timeout";
}

/** Periodic status from the documented statusline feed. */
export interface StatusEvent extends IRBase {
  kind: "status";
  model?: string;
  costUsd?: number;
  contextUsedPct?: number;
  cliVersion?: string;
  /** Full documented statusline payload (already a contract surface). */
  raw: unknown;
}

/** Turn completed (Stop hook — deterministic, no quiescence heuristics). */
export interface TurnCompleteEvent extends IRBase {
  kind: "turn.complete";
  lastAssistantMessage?: string;
}

/** The session is blocked waiting on something (Notification hook). */
export interface AwaitingEvent extends IRBase {
  kind: "awaiting";
  what: "permission" | "idle" | "other";
  message?: string;
}

/** Host-level or stream-level error (never thrown across the IR boundary). */
export interface ErrorEvent extends IRBase {
  kind: "error";
  message: string;
  detail?: unknown;
}

/**
 * Anything the adapter did not recognize. Logged, counted (drift telemetry),
 * preserved raw, and rendered generically — never dropped, never fatal.
 */
export interface UnknownEvent extends IRBase {
  kind: "unknown";
  /** e.g. the transcript entry `type` or hook `hook_event_name`. */
  tag?: string;
  raw: unknown;
}

export type IREvent =
  | SessionLifecycleEvent
  | MessageUserEvent
  | MessageAssistantEvent
  | ThinkingEvent
  | ToolUseEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | PermissionResolvedEvent
  | StatusEvent
  | TurnCompleteEvent
  | AwaitingEvent
  | ErrorEvent
  | UnknownEvent;

export type IREventKind = IREvent["kind"];

/** Drift telemetry: counts of unrecognized payloads per tag, per surface. */
export interface DriftReport {
  bySurface: Record<IRSurface, Record<string, number>>;
  total: number;
}

export function emptyDriftReport(): DriftReport {
  return {
    bySurface: { transcript: {}, hook: {}, statusline: {}, actuator: {} },
    total: 0,
  };
}

export function recordDrift(report: DriftReport, surface: IRSurface, tag: string): void {
  const bucket = report.bySurface[surface];
  bucket[tag] = (bucket[tag] ?? 0) + 1;
  report.total += 1;
}
