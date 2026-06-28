// Chat SDK connector — speaks the Vercel AI SDK "UI Message Stream" protocol so
// any `useChat`/`DefaultChatTransport` client (or curl) drives Genesis directly.
// No frontend ships here: the Hono server IS the channel.
//
// Wire format (AI SDK UI message stream, v1):
//   headers: x-vercel-ai-ui-message-stream: v1, content-type: text/event-stream
//   body:    `data: {json}\n\n` parts, terminated by `data: [DONE]\n\n`
//   parts:   start · text-start · text-delta · text-end · error · finish

import { EFFORT_LEVELS, type EffortLevel } from "./types";
import type { ChannelConnector, IncomingMessage, OutgoingEvent } from "./types";

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
  const effortRaw = typeof b.effort === "string" ? b.effort.trim() : "";
  const effort = (EFFORT_LEVELS as readonly string[]).includes(effortRaw)
    ? (effortRaw as EffortLevel)
    : undefined;

  return { threadId, text, model, effort };
}

// ───────────────────────────── encoding ─────────────────────────────

export type UiStreamPart =
  | { type: "start"; messageId: string }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "error"; errorText: string }
  | { type: "finish" };

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
  let errored: string | undefined;

  try {
    for await (const ev of events) {
      if (ev.kind === "error") {
        errored = ev.message;
        break;
      }
      const text = ev.text;
      if (typeof text !== "string" || text.length === 0) continue;

      // A non-prefix block can't extend the open part → close it, start fresh.
      if (currentId !== null && !text.startsWith(emitted)) {
        yield { type: "text-end", id: currentId };
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

  if (currentId !== null) yield { type: "text-end", id: currentId };
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
