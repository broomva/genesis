// Boot-time durable-state reconciliation (BRO-1530).
//
// The runner already enforces F20 within a process: "a crash with no terminal
// result must surface as `blocked`, not a stuck `running`". But that guard runs
// AFTER the agent subprocess exits — it cannot fire if the whole api process is
// killed mid-turn (a deploy, an OOM, the 2026-06-19 port relocation). Then the
// store keeps `phase: "running"` for that thread forever, so `/status` lies and
// any phase-keyed logic is confused.
//
// This extends F20 across the process-crash boundary: at boot, any session left
// mid-turn is reconciled to `blocked`. Thread → Claude-session resume continuity
// is unaffected — `agentSessionId` is already durable, so the NEXT turn resumes
// the conversation. We deliberately do NOT auto-retry the interrupted prompt: a
// coding agent may have partially applied side effects, so re-running is unsafe
// (the whole-turn boundary is the durability unit — coarse on purpose).
//
// Both non-terminal phases are orphaned by a crash (`isTerminal` in the reducer
// excludes them): `running` (agent mid-turn) and `awaiting` (agent paused for
// human input on the live interactive session). Within a process the runner's
// F20 preserves `awaiting` because the live session is still alive to receive the
// answer; across a process crash that session is dead, so a stored `awaiting` is
// exactly as stale as a stored `running` — both must be reconciled.

import type { Store } from "./store";
import type { Session } from "./types";

/** Non-terminal phases left dangling when the process died mid-turn. */
export const INTERRUPTED_PHASES: readonly Session["phase"][] = ["running", "awaiting"];

export interface ReconcileResult {
  /** Sessions whose interrupted phase was reset to `blocked`. */
  reconciled: number;
  threadIds: string[];
}

/**
 * Reset any session left in an interrupted phase to `blocked` so the durable
 * state is truthful after a crash. Idempotent: a second run finds nothing.
 */
export async function reconcileInterruptedSessions(store: Store): Promise<ReconcileResult> {
  const orphaned = await store.findSessionsByPhase(INTERRUPTED_PHASES);
  const threadIds: string[] = [];
  for (const s of orphaned) {
    await store.upsertSession({ ...s, phase: "blocked" });
    threadIds.push(s.threadId);
  }
  return { reconciled: orphaned.length, threadIds };
}
