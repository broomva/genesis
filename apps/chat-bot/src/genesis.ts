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

/** Parse the Genesis SSE body into ordered UI-stream parts. Handles chunk
 *  boundaries (a part may be split across reads) and skips `[DONE]`/non-data. */
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
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const line = frame.trim();
        if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          if (payload !== "[DONE]") {
            try {
              yield JSON.parse(payload) as UiPart;
            } catch {
              /* ignore non-JSON keepalive/comment frames */
            }
          }
        }
        nl = buf.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
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
