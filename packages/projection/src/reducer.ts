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
  type AgentMessage,
  contentBlocksOf,
  sessionIdOf,
  streamBlockStart,
  streamTextDelta,
  streamThinkingDelta,
  streamThinkingTokens,
  textBlocks,
  toolUses,
} from "./parser";

export type RunPhase = "idle" | "running" | "awaiting" | "blocked" | "done";

/** Lifecycle of a tool part: issued (input known) → result filled (ok | error).
 *  Mirrors the AI SDK v6 dynamic-tool states the UI renders. */
export type ToolPartState = "input-available" | "output-available" | "output-error";

/** One executed tool call in the turn timeline (BRO-1607). `output` is undefined
 *  until the matching `tool_result` arrives; `state` advances input → output. */
export interface ToolPart {
  type: "tool";
  /** The tool_use id — the join key to its tool_result. */
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  state: ToolPartState;
}

/** An ordered fragment of an assistant turn. Text and tool calls interleave in
 *  the exact order the agent produced them, so the chat renders (and a reload
 *  rebuilds) "say X · run tool · say Y" faithfully instead of collapsing to the
 *  final answer text. Reasoning is tracked separately (redacted prose →
 *  `thinkingTokens`), not as a part. */
export type TurnPart = { type: "text"; text: string } | ToolPart;

/** Tool names that are HITL gates, not renderable tool calls — kept out of the
 *  parts timeline (the `awaiting` phase + question UI handle them). */
const TIMELINE_SKIP_TOOLS = new Set(["AskUserQuestion", "ask_user_question"]);

/** Append a complete assistant message's text + tool_use blocks to the timeline,
 *  in content order (BRO-1607). */
function appendAssistantParts(prev: TurnPart[], msg: AgentMessage): TurnPart[] {
  const out = prev.slice();
  for (const b of contentBlocksOf(msg)) {
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
      out.push({ type: "text", text: b.text });
    } else if (
      b.type === "tool_use" &&
      typeof b.name === "string" &&
      typeof b.id === "string" &&
      !TIMELINE_SKIP_TOOLS.has(b.name)
    ) {
      out.push({
        type: "tool",
        toolCallId: b.id,
        toolName: b.name,
        input: b.input,
        state: "input-available",
      });
    }
  }
  return out;
}

/** Fold a complete user message's tool_result blocks into their tool parts —
 *  matched by tool_use id, advancing each to output-available / output-error. */
function applyToolResults(prev: TurnPart[], msg: AgentMessage): TurnPart[] {
  const results = contentBlocksOf(msg).filter(
    (b) => b.type === "tool_result" && typeof b.tool_use_id === "string",
  );
  if (results.length === 0) return prev;
  const out = prev.slice();
  for (const r of results) {
    const idx = out.findIndex(
      (p) => p.type === "tool" && p.toolCallId === r.tool_use_id && p.state === "input-available",
    );
    if (idx < 0) continue;
    const tp = out[idx] as ToolPart;
    out[idx] = {
      ...tp,
      output: r.content,
      state: r.is_error === true ? "output-error" : "output-available",
    };
  }
  return out;
}

/** Clean per-turn token usage (BRO-1597) — the reducer's projection of the CLI's
 *  RawUsage. `input` excludes cache; cache tokens are tracked separately so the
 *  context-window meter can sum input+cacheRead+cacheCreation (the real prompt
 *  size) while cost stays claude's exact number. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

function toTokenUsage(u: import("./parser").RawUsage | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheCreation: u.cache_creation_input_tokens ?? 0,
  };
}

export interface RunState {
  phase: RunPhase;
  sessionId?: string;
  lastText?: string;
  /** Terminal-turn token usage + exact cost (BRO-1597), folded from the `result`
   *  event. Undefined until the turn ends (or if the CLI omitted them). */
  usage?: TokenUsage;
  costUsd?: number;
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
  /** Ordered text+tool timeline for the turn (BRO-1607), built from the COMPLETE
   *  assistant/user events. Drives live tool rendering + faithful reload; the
   *  live answer text still streams via `lastText` (partial deltas). Optional so
   *  partial RunState literals (tests, other engines) stay valid — read `?? []`. */
  parts?: TurnPart[];
  turns: number;
  pendingQuestion?: string;
  error?: string;
}

export const initialState: RunState = { phase: "running", turns: 0, parts: [] };

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
      // Fold this step's text + tool_use blocks into the ordered timeline (BRO-1607).
      const parts = appendAssistantParts(state.parts ?? [], event.message);
      const awaiting = toolUses(event.message).find((t) => AWAIT_TOOLS.has(t.name));
      if (awaiting) {
        return {
          ...state,
          sessionId,
          phase: "awaiting",
          lastText,
          parts,
          turns: state.turns + 1,
          pendingQuestion: extractQuestion(awaiting.input) ?? lastText,
        };
      }
      return { ...state, sessionId, phase: "running", lastText, parts, turns: state.turns + 1 };
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
      // A tool_result returned — the agent resumes; clear any awaiting gate and
      // fold the result into its tool part (BRO-1607).
      return {
        ...state,
        sessionId,
        phase: "running",
        parts: applyToolResults(state.parts ?? [], event.message),
        pendingQuestion: undefined,
      };

    case "result": {
      // Usage + cost ride EVERY terminal result (BRO-1597), captured before the
      // branch — an errored turn still bills the tokens it consumed (and an
      // awaiting/HITL turn still records its spend), so all three exits fold them.
      const usage = toTokenUsage(event.usage) ?? state.usage;
      const costUsd = event.total_cost_usd ?? state.costUsd;
      const errored =
        event.is_error === true || (event.subtype !== undefined && event.subtype !== "success");
      if (errored) {
        return {
          ...state,
          sessionId,
          phase: "blocked",
          error: event.subtype ?? "error",
          pendingQuestion: undefined,
          usage,
          costUsd,
        };
      }
      // A turn-ending result while gated on a human keeps the run awaiting (F4).
      if (state.phase === "awaiting") {
        return { ...state, sessionId, usage, costUsd };
      }
      return {
        ...state,
        sessionId,
        phase: "done",
        lastText: event.result ?? state.lastText,
        pendingQuestion: undefined,
        usage,
        costUsd,
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
