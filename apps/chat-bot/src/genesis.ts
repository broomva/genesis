// Bridge the Genesis engine's `/api/chat` (Vercel AI SDK UI message stream) into
// an `AsyncIterable<string>` that Chat SDK's `thread.post()` streams to a chat
// platform. The Telegram channel is thin: a message in → this stream out.
//
// Genesis emits one-or-more TEXT parts (the agent's narration blocks + final
// answer). For a single chat message we concatenate them, inserting a blank line
// between distinct blocks so the preamble and the answer read as paragraphs.

export interface GenesisStreamOptions {
  /** Genesis base URL, e.g. https://genesis-production-c94a.up.railway.app */
  baseUrl: string;
  /** Stable conversation id → Genesis session (continuity). Use thread.id. */
  threadId: string;
  /** The user's message text. */
  text: string;
  /** Optional bearer token if the Genesis deploy sets GENESIS_TOKEN. */
  token?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** AbortSignal to cancel the request. */
  signal?: AbortSignal;
}

/** The AI SDK chat request body Genesis `/api/chat` expects. */
export function buildRequestBody(threadId: string, text: string) {
  return {
    id: threadId,
    messages: [{ role: "user", parts: [{ type: "text", text }] }],
  };
}

type UiPart =
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "error"; errorText: string }
  | { type: string; [k: string]: unknown };

/** Parse one SSE frame's `data:` payload into a part, or null for
 *  `[DONE]`/keepalive/non-JSON noise. */
function parseFrame(frame: string): UiPart | null {
  const line = frame.trim();
  if (!line.startsWith("data: ")) return null;
  const payload = line.slice(6);
  if (payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as UiPart;
  } catch {
    return null; // non-JSON keepalive/comment frame
  }
}

/** Parse the Genesis SSE body into ordered UI-stream parts. Handles chunk
 *  boundaries (a part may be split across reads), flushes a final frame that
 *  lacks a trailing blank line (truncated tail), and cancels the body on early
 *  stop so an abandoned read propagates back-pressure to Genesis (a billed
 *  microVM stops generating instead of running on with no listener). */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<UiPart> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n\n");
      while (nl >= 0) {
        const part = parseFrame(buf.slice(0, nl));
        buf = buf.slice(nl + 2);
        if (part) yield part;
        nl = buf.indexOf("\n\n");
      }
    }
    // Flush any trailing frame not terminated by a blank line (truncated tail).
    buf += decoder.decode();
    const tail = parseFrame(buf);
    if (tail) yield tail;
  } finally {
    // cancel() (not just releaseLock) aborts the underlying response on early
    // stop — no-op if the stream already completed.
    await reader.cancel().catch(() => {});
  }
}

/** POST to Genesis `/api/chat` and yield the assistant's reply text, block by
 *  block, as a stream Chat SDK can post+edit into a thread. Throws on transport
 *  failure or a Genesis `error` part (so the caller can surface a failure). */
export async function* genesisStream(opts: GenesisStreamOptions): AsyncGenerator<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${opts.baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: JSON.stringify(buildRequestBody(opts.threadId, opts.text)),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Genesis /api/chat failed: HTTP ${res.status}`);
  }

  let blocks = 0;
  let errorText: string | undefined;
  for await (const part of parseSse(res.body)) {
    if (part.type === "text-start") {
      if (blocks > 0) yield "\n\n"; // separate distinct narration blocks
      blocks++;
    } else if (part.type === "text-delta" && typeof part.delta === "string") {
      if (part.delta.length > 0) yield part.delta;
    } else if (part.type === "error") {
      errorText = typeof part.errorText === "string" ? part.errorText : "agent error";
      break;
    }
  }
  if (errorText !== undefined) throw new Error(errorText);
}
