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
  type: string; // "text" | "tool_use" | "tool_result"
  text?: string;
  name?: string; // tool name (tool_use)
  input?: unknown; // tool args (tool_use)
  content?: unknown; // tool output (tool_result)
  is_error?: boolean;
}

/** The `message` envelope on assistant/user events. */
export interface AgentMessage {
  role?: string;
  content?: ContentBlock[] | string;
}

/** A parsed event from a coding-agent CLI stream-json line, tagged by `type`. */
export type AgentEvent =
  | { type: "system"; subtype?: string; session_id?: string }
  | { type: "assistant"; message: AgentMessage; session_id?: string }
  | { type: "user"; message: AgentMessage; session_id?: string }
  | {
      type: "result";
      subtype?: string;
      session_id?: string;
      is_error?: boolean;
      result?: string;
    };

const KNOWN = new Set(["system", "assistant", "user", "result"]);

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
