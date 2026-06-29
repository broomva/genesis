//! NDJSON (stream-json) event parsing for coding-agent CLI output.
//
// Borrowed *pattern* (not code) from Houston `parser.rs` / Hawthorne
// `hawthorne-terminal`. The taxonomy mirrors the Claude CLI's
// `--output-format stream-json` shape: `system` (session start),
// `assistant` / `user` (messages), `result` (session complete).
// `session_id` threads through every event, which is how `--resume`
// continuity is recovered (Houston `session_id_tracker` learning).

/** A single content block inside an assistant/user message. */
export interface ContentBlock {
  type: string; // "text" | "tool_use" | "tool_result" | "thinking"
  text?: string;
  id?: string; // tool_use call id — links a tool_use to its later tool_result
  name?: string; // tool name (tool_use)
  input?: unknown; // tool args (tool_use)
  tool_use_id?: string; // tool_result → the id of the tool_use it answers
  content?: unknown; // tool output (tool_result)
  is_error?: boolean;
}

/** The `message` envelope on assistant/user events. */
export interface AgentMessage {
  role?: string;
  content?: ContentBlock[] | string;
}

/** A raw Anthropic streaming event wrapped by `--include-partial-messages`
 *  (the `stream_event` envelope, BRO-1571). We model only the fields the reducer
 *  folds on; everything else passes through untyped. Sub-`type` is one of:
 *  message_start, content_block_start, content_block_delta, content_block_stop,
 *  message_delta, message_stop. Text tokens arrive as `delta.type==="text_delta"`
 *  (`delta.text`); extended-thinking tokens as `"thinking_delta"` (`delta.thinking`). */
export interface PartialStreamEvent {
  type: string;
  index?: number;
  // `estimated_tokens` rides on thinking_delta — a running count of the model's
  // thinking budget. Under subscription/OAuth auth the `thinking` text is redacted
  // to "" (only signature + this count come through), so it is the ONLY usable
  // thinking signal on the VPS (BRO-1574).
  delta?: { type?: string; text?: string; thinking?: string; estimated_tokens?: number };
  content_block?: { type?: string };
}

/** Raw token usage on a `result` event (and assistant message riders) — the
 *  CLI's native field names (BRO-1597). Mapped to a clean {@link TokenUsage} in
 *  the reducer. All fields optional: a turn that errors early may omit them. */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** A parsed event from a coding-agent CLI stream-json line, tagged by `type`. */
export type AgentEvent =
  | { type: "system"; subtype?: string; session_id?: string }
  | { type: "assistant"; message: AgentMessage; session_id?: string }
  | { type: "user"; message: AgentMessage; session_id?: string }
  // Token-level partial under `--include-partial-messages` (BRO-1571): the
  // incremental channel that makes the chat stream instead of land all at once.
  | { type: "stream_event"; event: PartialStreamEvent; session_id?: string }
  | {
      type: "result";
      subtype?: string;
      session_id?: string;
      is_error?: boolean;
      result?: string;
      // Token usage + exact cost the CLI computes on the terminal result line
      // (BRO-1597). `total_cost_usd` is claude's own number — no pricing table.
      usage?: RawUsage;
      total_cost_usd?: number;
    };

const KNOWN = new Set(["system", "assistant", "user", "result", "stream_event"]);

/**
 * Parse a single NDJSON line into an {@link AgentEvent}.
 * Returns `null` for blank lines, malformed JSON, or unrecognized event
 * types (the CLI occasionally emits non-event diagnostic lines).
 */
export function parseLine(line: string): AgentEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || !KNOWN.has(type)) return null;
  return value as AgentEvent;
}

/** Parse a whole NDJSON blob into the ordered list of recognized events. */
export function parseStream(blob: string): AgentEvent[] {
  return blob
    .split("\n")
    .map(parseLine)
    .filter((e): e is AgentEvent => e !== null);
}

/** Extract the `session_id` carried by any event that has one. */
export function sessionIdOf(event: AgentEvent): string | undefined {
  return "session_id" in event ? event.session_id : undefined;
}

function blocks(msg: AgentMessage): ContentBlock[] {
  return Array.isArray(msg.content) ? msg.content : [];
}

/** All text fragments in a message, in order. */
export function textBlocks(msg: AgentMessage): string[] {
  if (typeof msg.content === "string") return [msg.content];
  return blocks(msg)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string);
}

/** All tool_use blocks in a message. */
export function toolUses(msg: AgentMessage): Array<{ name: string; input: unknown }> {
  return blocks(msg)
    .filter((b) => b.type === "tool_use" && typeof b.name === "string")
    .map((b) => ({ name: b.name as string, input: b.input }));
}

/** The ordered content blocks of a COMPLETE assistant/user message, with a plain
 *  string body normalized to a single text block. The reducer folds these into
 *  the ordered per-turn parts timeline (text · tool), so interleaving (text →
 *  tool_use → tool_result → text) is preserved for both render and persistence
 *  (BRO-1607). `stream_event` partials drive live text separately and are not
 *  part of this — the timeline is built only from complete messages. */
export function contentBlocksOf(msg: AgentMessage): ContentBlock[] {
  if (typeof msg.content === "string") return [{ type: "text", text: msg.content }];
  return blocks(msg);
}

// ── Partial-message (stream_event) accessors (BRO-1571) ──
// Small pure readers so the reducer stays declarative about the incremental
// token channel without re-deriving the Anthropic delta shape inline.

/** The text fragment of a `content_block_delta` / `text_delta`, else undefined. */
export function streamTextDelta(ev: PartialStreamEvent): string | undefined {
  return ev.type === "content_block_delta" && ev.delta?.type === "text_delta"
    ? ev.delta.text
    : undefined;
}

/** The reasoning fragment of a `content_block_delta` / `thinking_delta`, else undefined. */
export function streamThinkingDelta(ev: PartialStreamEvent): string | undefined {
  return ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta"
    ? ev.delta.thinking
    : undefined;
}

/** The running thinking-token estimate on a `thinking_delta`, else undefined.
 *  The usable thinking signal when the prose is redacted (BRO-1574). */
export function streamThinkingTokens(ev: PartialStreamEvent): number | undefined {
  return ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta"
    ? ev.delta.estimated_tokens
    : undefined;
}

/** The content-block kind ("text" | "thinking" | …) when a new block begins,
 *  else undefined. A new block is the reset boundary for its accumulator. */
export function streamBlockStart(ev: PartialStreamEvent): string | undefined {
  return ev.type === "content_block_start" ? ev.content_block?.type : undefined;
}
