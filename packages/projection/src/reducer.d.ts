import { type AgentEvent } from "./parser";
export type RunPhase = "running" | "awaiting" | "blocked" | "done";
export interface RunState {
    /** Current projected phase. */
    phase: RunPhase;
    /** Resumable session id (Houston `session_id_tracker` continuity). */
    sessionId?: string;
    /** Last assistant text seen — what the chat surface shows as the reply. */
    lastText?: string;
    /** Number of assistant turns observed. */
    turns: number;
    /** When `phase === "awaiting"`, the question put to the human. */
    pendingQuestion?: string;
    /** When `phase === "blocked"`, why. */
    error?: string;
}
export declare const initialState: RunState;
/** Apply one event to the run state. Pure; safe to replay. */
export declare function reduce(state: RunState, event: AgentEvent): RunState;
/** Fold a whole event stream from the initial state. */
export declare function reduceAll(events: AgentEvent[], from?: RunState): RunState;
