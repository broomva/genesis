//! NDJSON (stream-json) event parsing for coding-agent CLI output.
//
// Borrowed *pattern* (not code) from Houston `parser.rs` / Hawthorne
// `hawthorne-terminal`. The taxonomy mirrors the Claude CLI's
// `--output-format stream-json` shape: `system` (session start),
// `assistant` / `user` (messages), `result` (session complete).
// `session_id` threads through every event, which is how `--resume`
// continuity is recovered (Houston `session_id_tracker` learning).
const KNOWN = new Set(["system", "assistant", "user", "result"]);
/**
 * Parse a single NDJSON line into an {@link AgentEvent}.
 * Returns `null` for blank lines, malformed JSON, or unrecognized event
 * types (the CLI occasionally emits non-event diagnostic lines).
 */
export function parseLine(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0)
        return null;
    let value;
    try {
        value = JSON.parse(trimmed);
    }
    catch {
        return null;
    }
    if (typeof value !== "object" || value === null)
        return null;
    const type = value.type;
    if (typeof type !== "string" || !KNOWN.has(type))
        return null;
    return value;
}
/** Parse a whole NDJSON blob into the ordered list of recognized events. */
export function parseStream(blob) {
    return blob
        .split("\n")
        .map(parseLine)
        .filter((e) => e !== null);
}
/** Extract the `session_id` carried by any event that has one. */
export function sessionIdOf(event) {
    return "session_id" in event ? event.session_id : undefined;
}
function blocks(msg) {
    return Array.isArray(msg.content) ? msg.content : [];
}
/** All text fragments in a message, in order. */
export function textBlocks(msg) {
    if (typeof msg.content === "string")
        return [msg.content];
    return blocks(msg)
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text);
}
/** All tool_use blocks in a message. */
export function toolUses(msg) {
    return blocks(msg)
        .filter((b) => b.type === "tool_use" && typeof b.name === "string")
        .map((b) => ({ name: b.name, input: b.input }));
}
