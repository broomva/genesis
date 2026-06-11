// @genesis/session-host — contract-first wrap of interactive Claude Code.
//
// Stability-ladder architecture (BRO-1475/BRO-1484): observe via documented
// contracts (hooks, statusline, API-shaped transcript), actuate via an
// isolated PTY module, render-only raw fallback, version pin + drift telemetry.

export { ClaudeCodeAdapter } from "./adapter";
export { type InputActuator, type SpawnSpec, TmuxActuator } from "./actuator";
export {
  ControlServer,
  type ControlServerOptions,
  type PendingPermission,
  type PermissionPolicy,
} from "./control";
export { buildSessionSettings, type ShimOptions } from "./hookshim";
export * from "./ir";
export {
  type CreateSessionOptions,
  resolveClaudeBinary,
  SessionHost,
  SessionHub,
  type SessionHubOptions,
} from "./session";
export { TranscriptTailer, type TailerOptions } from "./tailer";
