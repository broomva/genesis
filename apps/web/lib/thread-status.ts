// Client-side stream reconciliation primitives (BRO-1640). The chat stream
// (`/api/chat` SSE via useChat) is BEST-EFFORT live UI; the durable store is the
// source of truth. iOS suspends the in-flight fetch when the PWA backgrounds → the
// stream rejects ("Load failed") and useChat goes to status "error". The turn keeps
// running server-side, so recovery is: read the server phase + refetch the durable
// transcript, NOT crash. These are the pure, testable pieces the reconcile hook wires.

import type { ThreadPhase } from "./threads";

/** A turn is IN FLIGHT server-side at these phases — the client keeps the "working"
 *  indicator + keeps polling. Deliberately NOT the inverse of a "terminal" set:
 *  `null` (a failed/unreachable status fetch) is NOT running, but it must not be
 *  treated as SETTLED either (that would stop polling a turn that may still be live,
 *  CodeRabbit). Callers gate polling on `isRunningPhase(p) || unresolved`, so an
 *  unknown phase keeps retrying via the unresolved path rather than false-settling. */
export function isRunningPhase(p: ThreadPhase | null | undefined): boolean {
  return p === "running" || p === "awaiting";
}

/** useChat's status enum (mirrors @ai-sdk/react). */
export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

/** The unified run mode the UI renders — decouples "is the turn running" from the
 *  live-stream lifecycle so a dropped stream doesn't read as a crash. */
export type RunMode = "idle" | "streaming" | "working" | "reconnecting" | "error";

/** Pure state machine: given the live-stream status, the last-known SERVER phase,
 *  whether a reconcile fetch is in flight, and whether an error is UNRESOLVED (the
 *  stream failed and we couldn't reach the engine to confirm the turn's fate), decide
 *  what the UI shows. The server phase is authoritative for "is the turn running /
 *  failed" — a live stream is just the nicer real-time view of it. Precedence matters:
 *
 *  - streaming:    a live SSE stream is connected (submitted/streaming).
 *  - error(blocked): the SERVER says the turn is blocked — a real failure, surfaced
 *                  even after clearError() un-wedged the composer (P20 CRIT-6).
 *  - working:      no live stream, but the server says the turn is still running.
 *  - reconnecting: a reconcile fetch is in flight (transient, calm — not danger).
 *  - error(unresolved): the stream errored AND the engine was unreachable to confirm
 *                  → a retryable error, NOT a silent idle (P20 CRIT-6 / HIGH-1).
 *  - idle:         settled, nothing running. */
export function deriveRunMode(input: {
  liveStatus: ChatStatus;
  serverPhase: ThreadPhase | null;
  reconciling: boolean;
  /** The stream errored and a status fetch could NOT confirm the turn (engine
   *  unreachable / null phase). Surfaced as a retryable error rather than swallowed. */
  unresolved?: boolean;
}): RunMode {
  const { liveStatus, serverPhase, reconciling, unresolved } = input;
  if (liveStatus === "submitted" || liveStatus === "streaming") return "streaming";
  // Server truth: a blocked turn is a real failure — show it even once the sticky
  // useChat error was cleared to un-wedge the composer.
  if (serverPhase === "blocked") return "error";
  // Server truth: still running → working, even if the live stream dropped/erred.
  if (serverPhase === "running" || serverPhase === "awaiting") return "working";
  // A reconcile fetch is in flight → transient, calm.
  if (reconciling) return "reconnecting";
  // Errored + couldn't confirm via the server → a retryable error, never a silent idle.
  if (unresolved) return "error";
  // Pre-reconcile window (error not yet cleared): a done turn is about to be refetched
  // (reconnect); anything else errored is surfaced.
  if (liveStatus === "error") return serverPhase === "done" ? "reconnecting" : "error";
  return "idle";
}

/** Fetch one thread's current server phase via the BFF `/api/control` status action
 *  (forwards to the engine `POST /control {action:"status"}`). Returns the phase, or
 *  null on any failure (caller treats null as "unknown" → keeps the last-known state
 *  rather than forcing a false terminal). Never throws. */
export async function fetchThreadStatus(
  threadId: string,
  signal?: AbortSignal,
): Promise<ThreadPhase | null> {
  try {
    const res = await fetch("/api/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, action: "status" }),
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { phase?: unknown };
    const phase = data.phase;
    return phase === "idle" ||
      phase === "running" ||
      phase === "awaiting" ||
      phase === "blocked" ||
      phase === "done"
      ? phase
      : null;
  } catch {
    return null;
  }
}
