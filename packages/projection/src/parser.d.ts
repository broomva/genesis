/** A single content block inside an assistant/user message. */
export interface ContentBlock {
    type: string;
    text?: string;
    name?: string;
    input?: unknown;
    content?: unknown;
    is_error?: boolean;
}
/** The `message` envelope on assistant/user events. */
export interface AgentMessage {
    role?: string;
    content?: ContentBlock[] | string;
}
/** A parsed event from a coding-agent CLI stream-json line, tagged by `type`. */
export type AgentEvent = {
    type: "system";
    subtype?: string;
    session_id?: string;
} | {
    type: "assistant";
    message: AgentMessage;
    session_id?: string;
} | {
    type: "user";
    message: AgentMessage;
    session_id?: string;
} | {
    type: "result";
    subtype?: string;
    session_id?: string;
    is_error?: boolean;
    result?: string;
};
/**
 * Parse a single NDJSON line into an {@link AgentEvent}.
 * Returns `null` for blank lines, malformed JSON, or unrecognized event
 * types (the CLI occasionally emits non-event diagnostic lines).
 */
export declare function parseLine(line: string): AgentEvent | null;
/** Parse a whole NDJSON blob into the ordered list of recognized events. */
export declare function parseStream(blob: string): AgentEvent[];
/** Extract the `session_id` carried by any event that has one. */
export declare function sessionIdOf(event: AgentEvent): string | undefined;
/** All text fragments in a message, in order. */
export declare function textBlocks(msg: AgentMessage): string[];
/** All tool_use blocks in a message. */
export declare function toolUses(msg: AgentMessage): Array<{
    name: string;
    input: unknown;
}>;
