// Chat SDK connector — speaks the Vercel AI SDK "UI Message Stream" protocol so
// any `useChat`/`DefaultChatTransport` client (or curl) drives Genesis directly.
// No frontend ships here: the Hono server IS the channel.
//
// Wire format (AI SDK UI message stream, v1):
//   headers: x-vercel-ai-ui-message-stream: v1, content-type: text/event-stream
//   body:    `data: {json}\n\n` parts, terminated by `data: [DONE]\n\n`
//   parts:   start · text-start · text-delta · text-end · error · finish

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
  const b = body as { id?: unknown; messages?: unknown; message?: unknown };
  const threadId = typeof b.id === "string" && b.id ? b.id : "chat";

  let text = "";
  if (Array.isArray(b.messages)) {
    const lastUser = [...(b.messages as UIMessage[])].reverse().find((m) => m.role === "user");
    if (lastUser) text = messageText(lastUser);
  } else if (b.message && typeof b.message === "object") {
    text = messageText(b.message as UIMessage);
  }
  if (!text.trim()) throw new Error("chat request has no user text");
  return { threadId, text };
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

/** Fold the canonical OutgoingEvent stream into ordered UI-stream parts.
 *  Genesis surfaces the assistant text as a growing string (the reducer's
 *  lastText); we emit the new suffix as each `text-delta`. */
export async function* toUiStreamParts(
  events: AsyncIterable<OutgoingEvent>,
  ids: { messageId: string; textId: string },
): AsyncGenerator<UiStreamPart> {
  yield { type: "start", messageId: ids.messageId };
  yield { type: "text-start", id: ids.textId };
  let emitted = "";
  let errored: string | undefined;
  for await (const ev of events) {
    if (ev.kind === "error") {
      errored = ev.message;
      break;
    }
    const text = ev.text;
    if (typeof text !== "string" || text.length === 0) continue;
    // growing string → send the new suffix; replacement → send the whole text.
    const delta = text.startsWith(emitted) ? text.slice(emitted.length) : text;
    if (delta.length > 0) {
      yield { type: "text-delta", id: ids.textId, delta };
      emitted = text;
    }
  }
  yield { type: "text-end", id: ids.textId };
  if (errored) yield { type: "error", errorText: errored };
  yield { type: "finish" };
}

/** Build the streaming Response for the AI SDK UI message stream protocol. */
export function uiMessageStreamResponse(
  events: AsyncIterable<OutgoingEvent>,
  ids: { messageId: string; textId: string },
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        for await (const part of toUiStreamParts(events, ids)) {
          controller.enqueue(enc.encode(encodePart(part)));
        }
      } catch (e) {
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
  constructor(private readonly ids: () => { messageId: string; textId: string }) {}
  parseIncoming(body: unknown): IncomingMessage {
    return parseChatRequest(body);
  }
  encodeStream(events: AsyncIterable<OutgoingEvent>): Response {
    return uiMessageStreamResponse(events, this.ids());
  }
}
