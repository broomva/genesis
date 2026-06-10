// Channel layer — the convergent messaging contract (channel-connector-trait
// KG pattern). Every channel (Chat SDK, Telegram, Slack, …) normalizes to ONE
// canonical message; the runtime never reasons over a raw provider payload.
//
//   provider request ──parseIncoming──▶ IncomingMessage ──▶ Supervisor.dispatch
//                                                              │ onState
//   provider wire    ◀──encode──── OutgoingEvent ◀────────────┘
//
// A ChannelConnector is the only place that knows a provider's wire format.

import type { RunPhase } from "@genesis/projection";

/** Canonical inbound message — what every connector normalizes a request into. */
export interface IncomingMessage {
  /** Stable conversation id → Genesis thread/session (identity unification). */
  threadId: string;
  /** The user's text for this turn. */
  text: string;
}

/** Canonical outbound event — a live run transition or the final reply. */
export type OutgoingEvent =
  | { kind: "phase"; phase: RunPhase; text?: string }
  | { kind: "reply"; phase: RunPhase; text: string }
  | { kind: "error"; message: string };

/** Translates a provider's wire format ↔ the canonical contract. */
export interface ChannelConnector {
  /** Provider request body → canonical inbound message (or throw on a bad shape). */
  parseIncoming(body: unknown): IncomingMessage;
  /** Canonical events → the provider's response stream/payload. */
  encodeStream(events: AsyncIterable<OutgoingEvent>): Response;
}
