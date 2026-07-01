// Stream reconciliation hook (BRO-1640). Wires the pure pieces in ./thread-status
// into useChat so a dropped stream (iOS backgrounding the PWA → "Load failed") is a
// RECOVERABLE state, not a dead-end crash. The turn keeps running server-side, so on
// error / foreground-return this: (1) clears useChat's sticky error to un-wedge the
// composer, (2) reads the server phase, (3) polls until the turn settles and swaps in
// the durable transcript — without wiping the partial stream while it's still running.
//
// The decision logic lives in ./thread-status (unit-tested); this hook is thin glue
// over browser effects (visibility/pageshow/online listeners + a poll interval), which
// are exercised by the P11 device dogfood rather than headless tests (BRO-1634).

import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ChatStatus,
  type RunMode,
  deriveRunMode,
  fetchThreadStatus,
  isTerminalPhase,
} from "./thread-status";
import { type ThreadPhase, fetchThreadMessages } from "./threads";

/** How often to re-check a running turn while its live stream is gone (ms). */
const POLL_MS = 2500;

export function useThreadReconcile(opts: {
  threadId: string;
  /** useChat's status (the live-stream lifecycle). */
  liveStatus: ChatStatus;
  /** useChat's current error (truthy when the stream dropped/failed). */
  error: Error | undefined;
  /** The server phase the parent already knows (from its thread-list poll) — seeds
   *  the mode immediately when opening an already-running thread, before the first
   *  status fetch returns. */
  initialPhase?: ThreadPhase | null;
  /** Replace the displayed messages with the durable transcript (useChat.setMessages). */
  setMessages: (messages: UIMessage[]) => void;
  /** Clear useChat's sticky error → status returns to "ready", un-wedging the composer. */
  clearError: () => void;
}): { mode: RunMode; reconnect: () => void } {
  const { threadId, liveStatus, error, initialPhase, setMessages, clearError } = opts;
  const [serverPhase, setServerPhase] = useState<ThreadPhase | null>(initialPhase ?? null);
  const [reconciling, setReconciling] = useState(false);
  const inFlight = useRef(false); // guard against overlapping reconciles

  // Latest callbacks in refs so `reconcile` stays identity-stable (it must not
  // re-subscribe the listeners / restart the poll on every parent re-render).
  const setMessagesRef = useRef(setMessages);
  const clearErrorRef = useRef(clearError);
  setMessagesRef.current = setMessages;
  clearErrorRef.current = clearError;
  // Latest live state, read by the foreground handler to decide whether a reconcile
  // is even warranted (skip it for a settled idle thread — no need to refetch +
  // replace messages on every tab focus).
  const stateRef = useRef({ liveStatus, serverPhase });
  stateRef.current = { liveStatus, serverPhase };

  const reconcile = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setReconciling(true);
    clearErrorRef.current(); // un-wedge the composer immediately (status → ready)
    try {
      const phase = await fetchThreadStatus(threadId);
      if (phase != null) setServerPhase(phase);
      // Swap in the durable transcript only once the turn has SETTLED — while it's
      // still running, keep the partial stream the user already sees. When terminal,
      // the transcript carries the completed (or blocked) agent turn.
      if (isTerminalPhase(phase)) {
        setMessagesRef.current(await fetchThreadMessages(threadId));
      }
    } finally {
      setReconciling(false);
      inFlight.current = false;
    }
  }, [threadId]);

  // (1) The stream errored (iOS background abort → "Load failed") → reconcile.
  useEffect(() => {
    if (error) void reconcile();
  }, [error, reconcile]);

  // (2) Reconcile on foreground return (visibility/pageshow) + network recovery —
  // but only when there's something to reconcile: the stream errored, or the server
  // turn is still (or last-known) running. A settled idle thread skips the refetch so
  // focusing the tab doesn't needlessly replace its messages.
  useEffect(() => {
    const onForeground = () => {
      if (document.visibilityState === "hidden") return;
      const { liveStatus: ls, serverPhase: sp } = stateRef.current;
      if (ls === "error" || !isTerminalPhase(sp)) void reconcile();
    };
    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("pageshow", onForeground);
    window.addEventListener("online", onForeground);
    return () => {
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("pageshow", onForeground);
      window.removeEventListener("online", onForeground);
    };
  }, [reconcile]);

  // (3) While the server turn is running but no live stream is delivering it (dropped
  // or opened a running thread), poll until it settles so the result lands with no
  // user action. Pauses while the tab is hidden.
  useEffect(() => {
    if (isTerminalPhase(serverPhase)) return; // nothing running
    if (liveStatus === "submitted" || liveStatus === "streaming") return; // stream is live
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") void reconcile();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [serverPhase, liveStatus, reconcile]);

  // Track the server phase off the live-stream lifecycle: a fresh stream means the
  // turn is running; a CLEAN completion (streaming → ready) means it settled (the
  // stream already delivered the result, so don't poll). Only a real transition
  // flips it — the initial mount (ready→ready) preserves the seeded initialPhase.
  const prevLive = useRef<ChatStatus>(liveStatus);
  useEffect(() => {
    const prev = prevLive.current;
    prevLive.current = liveStatus;
    if (liveStatus === "submitted" || liveStatus === "streaming") setServerPhase("running");
    else if (liveStatus === "ready" && (prev === "submitted" || prev === "streaming"))
      setServerPhase(null);
  }, [liveStatus]);

  return {
    mode: deriveRunMode({ liveStatus, serverPhase, reconciling }),
    reconnect: () => void reconcile(),
  };
}
