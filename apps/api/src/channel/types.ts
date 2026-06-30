// Channel layer — the convergent messaging contract (channel-connector-trait
// KG pattern). Every channel (Chat SDK, Telegram, Slack, …) normalizes to ONE
// canonical message; the runtime never reasons over a raw provider payload.
//
//   provider request ──parseIncoming──▶ IncomingMessage ──▶ Supervisor.dispatch
//                                                              │ onState
//   provider wire    ◀──encode──── OutgoingEvent ◀────────────┘
//
// A ChannelConnector is the only place that knows a provider's wire format.

import type { RunPhase, TokenUsage, ToolPart } from "@genesis/projection";
// EffortLevel lives in @genesis/runner (it owns the claude argv); re-export so
// channel consumers keep importing it from "./types" (single source of truth).
export { EFFORT_LEVELS, type EffortLevel } from "@genesis/runner";
import type { EffortLevel } from "@genesis/runner";

/** Canonical inbound message — what every connector normalizes a request into. */
export interface IncomingMessage {
  /** Stable conversation id → Genesis thread/session (identity unification). */
  threadId: string;
  /** The user's text for this turn. */
  text: string;
  /** Per-turn model override (claude alias: haiku|sonnet|opus|fable, or full id).
   *  Omitted → the engine default (claude-opus-4-8[1m]). */
  model?: string;
  /** Per-turn extended-thinking effort (`--effort`). Omitted → engine default. */
  effort?: EffortLevel;
  /** Requested agent engine (BRO-1620) — honored only on a thread's FIRST turn
   *  (per-thread sticky); ignored after. Omitted/unknown → the server default. */
  engine?: string;
}

/** Agent engines a client may request (BRO-1620). Validated in parseChatRequest;
 *  an unknown value is dropped so the supervisor falls back to its default engine.
 *  Keep in sync with the client's ENGINE_OPTIONS (apps/web lib/chat-options.ts). */
export const ENGINE_IDS = ["print", "interactive"] as const;

/** Canonical outbound event — a live run transition or the final reply.
 *  `reasoning` is a short human-readable thinking INDICATOR note (BRO-1574) — not
 *  verbatim chain-of-thought (redacted under subscription auth); the connector
 *  emits it once as AI-SDK reasoning parts before the answer text. A `tool` event
 *  carries one tool part of the turn timeline (BRO-1607) — emitted when a tool is
 *  issued (input-available) and again when its result fills (output-available /
 *  output-error); the connector renders these as AI-SDK dynamic-tool parts. */
export type OutgoingEvent =
  | { kind: "phase"; phase: RunPhase; text?: string; reasoning?: string }
  | { kind: "tool"; part: ToolPart }
  | {
      kind: "reply";
      phase: RunPhase;
      text: string;
      reasoning?: string;
      // Token usage + exact cost for the turn (BRO-1597) — rides the final reply,
      // surfaced to the client as AI-SDK message metadata.
      usage?: TokenUsage;
      costUsd?: number;
      // Server-measured agent run time in ms (BRO-1610) — also rides the reply.
      durationMs?: number;
    }
  | { kind: "error"; message: string };

/** Translates a provider's wire format ↔ the canonical contract. */
export interface ChannelConnector {
  /** Provider request body → canonical inbound message (or throw on a bad shape). */
  parseIncoming(body: unknown): IncomingMessage;
  /** Canonical events → the provider's response stream/payload. */
  encodeStream(events: AsyncIterable<OutgoingEvent>): Response;
}
