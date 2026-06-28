// Projection reducer — the make-or-break piece of Genesis Phase 1.
// Folds the parsed NDJSON AgentEvent stream into a single run-phase state
// machine the chat layer renders: idle | running | awaiting | blocked | done.
//
// Invariants (hardened after P20 cross-review):
//  - `done` and `blocked` are ABSORBING — trailing system/assistant lines after
//    a result (the CLI flushes these on --resume) can never un-terminate a run.
//  - the FIRST terminal result wins (a later success cannot erase an earlier error).
//  - `awaiting` survives a turn-ending `result`: under `claude -p` an
//    AskUserQuestion ends the turn, but the human still owes an answer, so the
//    run stays gated (HITL signal preserved) until a real answer arrives.

import {
  type AgentEvent,
  sessionIdOf,
  streamBlockStart,
  streamTextDelta,
  streamThinkingDelta,
  streamThinkingTokens,
  textBlocks,
  toolUses,
} from "./parser";

export type RunPhase = "idle" | "running" | "awaiting" | "blocked" | "done";

export interface RunState {
  phase: RunPhase;
  sessionId?: string;
  lastText?: string;
  /** Accumulated extended-thinking text from partial `thinking_delta` events
   *  (BRO-1571). Surfaced separately from `lastText` so the UI can render it in a
   *  collapsible Reasoning panel rather than inline with the answer. NOTE: under
   *  subscription/OAuth auth this is always "" (the prose is redacted) — use
   *  `thinkingTokens` as the is-thinking signal instead (BRO-1574). */
  reasoning?: string;
  /** Max thinking-token estimate seen this turn (BRO-1574). >0 ⇒ the model did
   *  extended thinking, even when the prose is redacted. The basis for the
   *  client's "Thought · ~N tokens" indicator. */
  thinkingTokens?: number;
  turns: number;
  pendingQuestion?: string;
  error?: string;
}

export const initialState: RunState = { phase: "running", turns: 0 };

/** Tool names that pause the run for human input (Phase 3 HITL seam). */
const AWAIT_TOOLS = new Set(["AskUserQuestion", "ask_user_question"]);

function isTerminal(phase: RunPhase): boolean {
  return phase === "done" || phase === "blocked";
}

function extractQuestion(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const qs = (input as { questions?: unknown }).questions;
  if (!Array.isArray(qs) || qs.length === 0) return undefined;
  const texts = qs
    .map((q) =>
      q && typeof q === "object" && typeof (q as { question?: unknown }).question === "string"
        ? (q as { question: string }).question
        : undefined,
    )
    .filter((t): t is string => t !== undefined);
  return texts.length > 0 ? texts.join(" | ") : undefined;
}

/** Apply one event to the run state. Pure; safe to replay. */
export function reduce(state: RunState, event: AgentEvent): RunState {
  if (isTerminal(state.phase)) return state; // absorbing terminal states (F2/F3)
  const sessionId = sessionIdOf(event) ?? state.sessionId;

  switch (event.type) {
    case "system":
      return { ...state, sessionId, phase: "running" };

    case "assistant": {
      const texts = textBlocks(event.message);
      const lastText = texts.length > 0 ? texts[texts.length - 1] : state.lastText;
      const awaiting = toolUses(event.message).find((t) => AWAIT_TOOLS.has(t.name));
      if (awaiting) {
        return {
          ...state,
          sessionId,
          phase: "awaiting",
          lastText,
          turns: state.turns + 1,
          pendingQuestion: extractQuestion(awaiting.input) ?? lastText,
        };
      }
      return { ...state, sessionId, phase: "running", lastText, turns: state.turns + 1 };
    }

    case "stream_event": {
      // Token-level partials (BRO-1571) — fold incremental deltas into `lastText`
      // (answer) / `reasoning` (thinking) so the chat streams. The COMPLETE
      // `assistant` event still arrives after and stays the authority for
      // turn-count + AskUserQuestion detection; by then the accumulated text
      // equals its final block, so it re-sets the same value (no double-emit).
      const ev = event.event;
      // A new content block resets its accumulator → a fresh text block won't
      // prefix-extend the previous one (the connector opens a new text part).
      const blockStart = streamBlockStart(ev);
      if (blockStart === "text") return { ...state, sessionId, phase: "running", lastText: "" };
      if (blockStart === "thinking")
        return { ...state, sessionId, phase: "running", reasoning: "" };
      const textDelta = streamTextDelta(ev);
      if (textDelta !== undefined) {
        return {
          ...state,
          sessionId,
          phase: "running",
          lastText: (state.lastText ?? "") + textDelta,
        };
      }
      // Capture the token estimate INDEPENDENTLY of the prose (P20 BRO-1574): the
      // prose is usually redacted to "" under subscription auth, and a future
      // thinking_delta could carry only estimated_tokens with no `thinking` key —
      // so the is-thinking signal must not hinge on the prose being present.
      const thinkingDelta = streamThinkingDelta(ev);
      const thinkingTokens = streamThinkingTokens(ev);
      if (thinkingDelta !== undefined || thinkingTokens !== undefined) {
        return {
          ...state,
          sessionId,
          phase: "running",
          reasoning: (state.reasoning ?? "") + (thinkingDelta ?? ""),
          thinkingTokens: Math.max(state.thinkingTokens ?? 0, thinkingTokens ?? 0),
        };
      }
      // message_start / content_block_stop / message_delta / message_stop — keep
      // the run alive, capture any session id, no text change.
      return { ...state, sessionId };
    }

    case "user":
      // A tool_result returned — the agent resumes; clear any awaiting gate.
      return { ...state, sessionId, phase: "running", pendingQuestion: undefined };

    case "result": {
      const errored =
        event.is_error === true || (event.subtype !== undefined && event.subtype !== "success");
      if (errored) {
        return {
          ...state,
          sessionId,
          phase: "blocked",
          error: event.subtype ?? "error",
          pendingQuestion: undefined,
        };
      }
      // A turn-ending result while gated on a human keeps the run awaiting (F4).
      if (state.phase === "awaiting") {
        return { ...state, sessionId };
      }
      return {
        ...state,
        sessionId,
        phase: "done",
        lastText: event.result ?? state.lastText,
        pendingQuestion: undefined,
      };
    }

    default:
      return state;
  }
}

/** Fold a whole event stream from the initial state. */
export function reduceAll(events: AgentEvent[], from: RunState = initialState): RunState {
  return events.reduce(reduce, from);
}
