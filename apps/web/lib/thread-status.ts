// Client-side stream reconciliation primitives (BRO-1640). The chat stream
// (`/api/chat` SSE via useChat) is BEST-EFFORT live UI; the durable store is the
// source of truth. iOS suspends the in-flight fetch when the PWA backgrounds → the
// stream rejects ("Load failed") and useChat goes to status "error". The turn keeps
// running server-side, so recovery is: read the server phase + refetch the durable
// transcript, NOT crash. These are the pure, testable pieces the reconcile hook wires.

import type { ThreadPhase } from "./threads";

/** A turn is settled (nothing more will stream) at these phases. `idle` = never ran;
 *  `done`/`blocked` = finished. `running`/`awaiting` mean a turn is still in flight
 *  server-side, so the client should keep the "working" indicator + keep polling. */
export function isTerminalPhase(p: ThreadPhase | null | undefined): boolean {
  return p == null || p === "done" || p === "blocked" || p === "idle";
}

/** useChat's status enum (mirrors @ai-sdk/react). */
export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

/** The unified run mode the UI renders — decouples "is the turn running" from the
 *  live-stream lifecycle so a dropped stream doesn't read as a crash. */
export type RunMode = "idle" | "streaming" | "working" | "reconnecting" | "error";

/** Pure state machine: given the live-stream status, the last-known SERVER phase,
 *  and whether a reconcile fetch is in flight, decide what the UI should show. The
 *  server phase is authoritative for "is the turn running" — a live stream is just
 *  the nicer real-time view of it.
 *
 *  - streaming: a live SSE stream is connected (submitted/streaming).
 *  - working:   no live stream, but the server says the turn is still running
 *               (backgrounded + returned, or opened an already-running thread).
 *  - reconnecting: the stream errored and we're fetching the durable result (transient).
 *  - error:     the stream errored AND the server turn is genuinely blocked (real fail).
 *  - idle:      settled, nothing running. */
export function deriveRunMode(input: {
  liveStatus: ChatStatus;
  serverPhase: ThreadPhase | null;
  reconciling: boolean;
}): RunMode {
  const { liveStatus, serverPhase, reconciling } = input;
  if (liveStatus === "submitted" || liveStatus === "streaming") return "streaming";
  // Server truth wins for "still running" — even if the live stream dropped/erred.
  if (serverPhase === "running" || serverPhase === "awaiting") return "working";
  // A reconcile fetch is in flight → transient, calm (not the danger hue).
  if (reconciling) return "reconnecting";
  // Stream errored with no running turn: a genuinely blocked turn is a real error;
  // a done/idle/unknown phase means the error is stale (we're about to refetch) →
  // treat as a brief reconnect, never a dead-end.
  if (liveStatus === "error") return serverPhase === "blocked" ? "error" : "reconnecting";
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
