// Chat SDK connector — speaks the Vercel AI SDK "UI Message Stream" protocol so
// any `useChat`/`DefaultChatTransport` client (or curl) drives Genesis directly.
// No frontend ships here: the Hono server IS the channel.
//
// Wire format (AI SDK UI message stream, v1):
//   headers: x-vercel-ai-ui-message-stream: v1, content-type: text/event-stream
//   body:    `data: {json}\n\n` parts, terminated by `data: [DONE]\n\n`
//   parts:   start · reasoning-* · text-* · tool-input/output-* · message-metadata · error · finish

import type { TokenUsage } from "@genesis/projection";
import { CODEX_EFFORT_LEVELS, EFFORT_LEVELS, ENGINE_IDS, type EffortLevel } from "./types";
import type { ChannelConnector, IncomingMessage, OutgoingEvent } from "./types";

/** Per-message metadata (BRO-1597) surfaced to `useChat` as `message.metadata`
 *  via the AI SDK v6 `message-metadata` stream part. */
export interface MessageMetadata {
  usage?: TokenUsage;
  costUsd?: number;
  /** Server-measured agent run time in ms (BRO-1610). */
  durationMs?: number;
}

// ───────────────────────────── parsing ─────────────────────────────

type UIPart = { type?: string; text?: string };
type UIMessage = { role?: string; content?: unknown; parts?: UIPart[] };

/** Pull the text out of an AI SDK UIMessage (parts[] form) or a plain
 *  {role, content:string} message. */
function messageText(m: UIMessage): string {
  if (Array.isArray(m.parts)) {
    return m.parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
  }
  return typeof m.content === "string" ? m.content : "";
}

/** Parse an AI SDK chat request body → canonical IncomingMessage.
 *  Accepts `{ id, messages: UIMessage[] }` (DefaultChatTransport) and the
 *  single-message `{ id, message }` trigger shape. Throws on an unusable body. */
export function parseChatRequest(body: unknown): IncomingMessage {
  if (typeof body !== "object" || body === null) throw new Error("chat request must be an object");
  const b = body as {
    id?: unknown;
    messages?: unknown;
    message?: unknown;
    model?: unknown;
    effort?: unknown;
    engine?: unknown;
  };
  const threadId = typeof b.id === "string" && b.id ? b.id : "chat";

  let text = "";
  if (Array.isArray(b.messages)) {
    const lastUser = [...(b.messages as UIMessage[])].reverse().find((m) => m.role === "user");
    if (lastUser) text = messageText(lastUser);
  } else if (b.message && typeof b.message === "object") {
    text = messageText(b.message as UIMessage);
  }
  if (!text.trim()) throw new Error("chat request has no user text");

  // Per-turn knobs (BRO-1573) ride as top-level body fields next to {id, messages}
  // because DefaultChatTransport merges per-call `sendMessage(_, {body})` there.
  // Validate to the allowed sets — an unknown effort/model is dropped (never
  // forwarded so the engine can't warn-and-fallback on a bad value).
  //
  // model MUST start with an alphanumeric (claude aliases haiku|sonnet|opus|fable
  // and full ids like claude-opus-4-8 all do): this rejects any dash-prefixed
  // value so it can never be reparsed as a CLI flag in `--model`'s slot (P20
  // BRO-1573 — the runner ALSO uses the equals-form as defense-in-depth).
  const modelRaw = typeof b.model === "string" ? b.model.trim() : "";
  const model = /^[A-Za-z0-9][\w.-]*$/.test(modelRaw) ? modelRaw : undefined;
  // Engine (BRO-1620) — validated against the allowlist; unknown dropped so the
  // supervisor falls back to its default (and binds it sticky on turn 1). Parsed
  // BEFORE effort because effort validates against the engine's PROVIDER set.
  const engineRaw = typeof b.engine === "string" ? b.engine.trim() : "";
  const engine = (ENGINE_IDS as readonly string[]).includes(engineRaw) ? engineRaw : undefined;
  // Effort is provider-specific (BRO-1623): codex reasoning effort
  // (minimal/low/medium/high) vs claude --effort (low…max). Validate against the
  // engine's set so `minimal` never reaches claude and `xhigh`/`max` never reach
  // codex — a cross-provider value is dropped (engine uses its own default).
  const effortRaw = typeof b.effort === "string" ? b.effort.trim() : "";
  const effortSet: readonly string[] = engine === "codex" ? CODEX_EFFORT_LEVELS : EFFORT_LEVELS;
  const effort = effortSet.includes(effortRaw) ? (effortRaw as EffortLevel) : undefined;

  return { threadId, text, model, effort, engine };
}

// ───────────────────────────── encoding ─────────────────────────────

export type UiStreamPart =
  | { type: "start"; messageId: string }
  // Reasoning parts (BRO-1574) — the AI-SDK v6 wire names; useChat aggregates
  // start/delta(s)/end into a single reasoning UIMessagePart the client renders.
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  // Dynamic-tool parts (BRO-1607) — the AI-SDK v6 wire names. The CLI's tools
  // (Bash, Read, …) aren't declared client-side, so they ride as DYNAMIC tools
  // (`dynamic: true` → a `dynamic-tool` UIMessagePart with `toolName`). useChat
  // aggregates input-available → output-available/error by toolCallId.
  | {
      type: "tool-input-available";
      toolCallId: string;
      toolName: string;
      input: unknown;
      dynamic: true;
    }
  | { type: "tool-output-available"; toolCallId: string; output: unknown; dynamic: true }
  | { type: "tool-output-error"; toolCallId: string; errorText: string; dynamic: true }
  // Usage/cost metadata (BRO-1597) — useChat merges `messageMetadata` into
  // `message.metadata`. Emitted once, just before `finish`.
  | { type: "message-metadata"; messageMetadata: MessageMetadata }
  | { type: "error"; errorText: string }
  | { type: "finish" };

/** A tool_result's error payload → a display string for `tool-output-error`
 *  (BRO-1607). The CLI's error content is usually a string, occasionally a block. */
function toToolErrorText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "Tool failed";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** Encode one part as an SSE event line. */
export function encodePart(part: UiStreamPart): string {
  return `data: ${JSON.stringify(part)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

export const UI_MESSAGE_STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-vercel-ai-ui-message-stream": "v1",
} as const;

export interface StreamIds {
  messageId: string;
  /** A fresh text-part id per distinct text block (multi-turn → multiple parts). */
  newTextId: () => string;
  /** A fresh id for the one-shot reasoning part (BRO-1574). */
  newReasoningId: () => string;
}

/** Fold the canonical OutgoingEvent stream into ordered UI-stream parts.
 *
 *  Genesis's reducer surfaces `lastText` as the LATEST assistant text BLOCK, not
 *  a monotonically growing string. The AI SDK client APPENDS every `text-delta`
 *  (it has no replace), so a naive "emit the whole new text on a non-prefix
 *  change" would concatenate unrelated turns into garbled output. Instead:
 *    - text that PREFIX-extends the current part → emit the new suffix (true
 *      incremental streaming within one block);
 *    - a NON-prefix block → close the current text part (`text-end`) and open a
 *      new one (`text-start` + fresh id), so blocks render separately.
 *  The error tail (`text-end` → `error` → `finish`) is owned here in a try/catch
 *  so it ALWAYS runs — including when the upstream producer (dispatch) rejects —
 *  leaving no dangling open text part. */
export async function* toUiStreamParts(
  events: AsyncIterable<OutgoingEvent>,
  ids: StreamIds,
): AsyncGenerator<UiStreamPart> {
  yield { type: "start", messageId: ids.messageId };
  let currentId: string | null = null;
  let emitted = "";
  // The text of the most-recently CLOSED text part (BRO-1607). After a tool closes
  // its bracketing text part, the tool_result `user` event re-sends the SAME
  // `lastText` (the reducer spreads it unchanged) — reopening a part for it would
  // duplicate the text. We remember the closed text and skip that stale re-emit.
  let closedText: string | null = null;
  let errored: string | undefined;
  // Reasoning is a ONE-SHOT indicator (BRO-1574): the latest note is captured from
  // phase events (which carry it while thinking, before any answer text) and
  // flushed once — as reasoning-start/delta/end — immediately before the first
  // text part, so thinking renders above the answer. Prose is redacted upstream,
  // so the note is a token-based summary, not verbatim chain-of-thought.
  let pendingReasoning = "";
  let reasoningFlushed = false;
  // Usage/cost rides the final `reply` event (BRO-1597); captured here and
  // flushed as a message-metadata part before `finish`.
  let metadata: MessageMetadata | undefined;

  function* flushReasoning(): Generator<UiStreamPart> {
    if (reasoningFlushed || pendingReasoning.length === 0) return;
    const rid = ids.newReasoningId();
    yield { type: "reasoning-start", id: rid };
    yield { type: "reasoning-delta", id: rid, delta: pendingReasoning };
    yield { type: "reasoning-end", id: rid };
    reasoningFlushed = true;
  }

  try {
    for await (const ev of events) {
      if (ev.kind === "error") {
        errored = ev.message;
        break;
      }
      // A tool part delimits the timeline (BRO-1607): close any open text part so
      // the tool renders as its own part (text → tool → text ordering), surface
      // reasoning before the first content, then emit the dynamic-tool chunk.
      // Handled before the phase|reply property access so `ev` narrows cleanly.
      if (ev.kind === "tool") {
        if (currentId === null) yield* flushReasoning();
        if (currentId !== null) {
          yield { type: "text-end", id: currentId };
          closedText = emitted;
          currentId = null;
          emitted = "";
        }
        const p = ev.part;
        if (p.state === "input-available") {
          yield {
            type: "tool-input-available",
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            input: p.input,
            dynamic: true,
          };
        } else if (p.state === "output-available") {
          yield {
            type: "tool-output-available",
            toolCallId: p.toolCallId,
            output: p.output,
            dynamic: true,
          };
        } else {
          yield {
            type: "tool-output-error",
            toolCallId: p.toolCallId,
            errorText: toToolErrorText(p.output),
            dynamic: true,
          };
        }
        continue;
      }
      // Capture the indicator note even on text-less thinking ticks (ev is
      // phase|reply here — the error case already broke above).
      if (ev.reasoning && ev.reasoning.length > 0) {
        pendingReasoning = ev.reasoning;
      }
      // The terminal reply carries usage/cost (BRO-1597) + run time (BRO-1610).
      if (
        ev.kind === "reply" &&
        (ev.usage !== undefined || ev.costUsd !== undefined || ev.durationMs !== undefined)
      ) {
        metadata = { usage: ev.usage, costUsd: ev.costUsd, durationMs: ev.durationMs };
      }
      const text = ev.text;
      if (typeof text !== "string" || text.length === 0) continue;

      // Stale re-emit (BRO-1607): a tool already closed this exact text into its own
      // part; the tool_result phase event carries the unchanged `lastText`. The part
      // is closed + fully streamed, so skip rather than reopen + duplicate it. (A
      // genuine next block carries different text; the parts timeline — built from
      // complete events — keeps the faithful record for reload.)
      if (currentId === null && text === closedText) continue;

      // Thinking precedes the answer → flush the reasoning part before the first
      // text part opens.
      if (currentId === null) yield* flushReasoning();

      // A non-prefix block can't extend the open part → close it, start fresh.
      if (currentId !== null && !text.startsWith(emitted)) {
        yield { type: "text-end", id: currentId };
        closedText = emitted;
        currentId = null;
        emitted = "";
      }
      if (currentId === null) {
        currentId = ids.newTextId();
        yield { type: "text-start", id: currentId };
      }
      const delta = text.slice(emitted.length); // text now prefixes-extends `emitted`
      if (delta.length > 0) {
        yield { type: "text-delta", id: currentId, delta };
        emitted = text;
      }
    }
  } catch (e) {
    errored = e instanceof Error ? e.message : String(e);
  }

  // Thinking with no answer text (rare) still surfaces the indicator.
  if (!reasoningFlushed) yield* flushReasoning();
  if (currentId !== null) yield { type: "text-end", id: currentId };
  if (metadata !== undefined) yield { type: "message-metadata", messageMetadata: metadata };
  if (errored !== undefined) yield { type: "error", errorText: errored };
  yield { type: "finish" };
}

/** Build the streaming Response for the AI SDK UI message stream protocol.
 *  `toUiStreamParts` owns the error tail (text-end → error → finish), so here we
 *  only guard the transport itself and always terminate with `[DONE]`. */
export function uiMessageStreamResponse(
  events: AsyncIterable<OutgoingEvent>,
  ids: StreamIds,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        for await (const part of toUiStreamParts(events, ids)) {
          controller.enqueue(enc.encode(encodePart(part)));
        }
      } catch (e) {
        // Defensive: a transport-level failure (not a producer error, which the
        // generator already folds into an `error` part). Surface + finish.
        controller.enqueue(
          enc.encode(
            encodePart({ type: "error", errorText: e instanceof Error ? e.message : String(e) }),
          ),
        );
        controller.enqueue(enc.encode(encodePart({ type: "finish" })));
      } finally {
        controller.enqueue(enc.encode(SSE_DONE));
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: UI_MESSAGE_STREAM_HEADERS });
}

/** The Chat SDK connector — the only place that knows the AI SDK wire format. */
export class ChatSdkConnector implements ChannelConnector {
  constructor(private readonly ids: () => StreamIds) {}
  parseIncoming(body: unknown): IncomingMessage {
    return parseChatRequest(body);
  }
  encodeStream(events: AsyncIterable<OutgoingEvent>): Response {
    return uiMessageStreamResponse(events, this.ids());
  }
}
