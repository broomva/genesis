// ClaudeCodeAdapter — the ONLY module that knows the shape of Claude Code's
// session transcript JSONL. Everything it can't recognize becomes an
// `unknown` IR event (log-and-continue; an unrecognized line must never stall
// the stream — the Vibe Kanban 2.1.7 lesson).
//
// Trust hierarchy inside a transcript line (stability ladder, BRO-1475):
// - The inner `message` of `user`/`assistant` entries follows the public
//   Anthropic Messages API shape (`role`, `content[]` blocks, `usage`) —
//   API-stable; this is what we render from.
// - The envelope (`uuid`, `parentUuid`, `timestamp`, `version`, …) and the
//   entry-type zoo (`attachment`, `last-prompt`, `pr-link`, …) are
//   UNDOCUMENTED and churn ~monthly. Everything here is optional-read,
//   nothing is required beyond `type`.

import { type DriftReport, type IREvent, emptyDriftReport, recordDrift } from "./ir";

/** Transcript entry types we deliberately do not surface as semantic events.
 *  They still increment nothing — they are *known* noise, not drift. */
const SILENT_TYPES = new Set([
  "ai-title",
  "last-prompt",
  "mode",
  "permission-mode",
  "file-history-snapshot",
  "queue-operation",
  "worktree-state",
  "pr-link",
  "custom-title",
  "agent-name",
  "agent-color",
  "attachment",
  "progress",
]);

interface AdapterOptions {
  sessionId: string;
  /** Called for every drift increment (optional observability tap). */
  onDrift?: (tag: string) => void;
}

export class ClaudeCodeAdapter {
  readonly drift: DriftReport = emptyDriftReport();
  private readonly sessionId: string;
  private readonly onDrift?: (tag: string) => void;
  /** Dedupe by envelope `uuid` ONLY. The CLI rewrites/repeats lines on
   *  retries/replays — but `message.id` is NOT a valid dedupe key: one API
   *  message is written as MULTIPLE transcript lines (one per content block),
   *  all sharing `message.id` + `requestId` with distinct `uuid`s (observed
   *  in the v2.1.173 fixture). Keying on message.id drops real blocks. */
  private readonly seen = new Set<string>();

  constructor(opts: AdapterOptions) {
    this.sessionId = opts.sessionId;
    this.onDrift = opts.onDrift;
  }

  /** Parse one raw JSONL line into zero or more IR events. Never throws. */
  lineToEvents(line: string): IREvent[] {
    const trimmed = line.trim();
    if (trimmed.length === 0) return [];
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      return [this.unknown("unparseable-line", trimmed)];
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [this.unknown("non-object-line", entry)];
    }
    return this.entryToEvents(entry as Record<string, unknown>);
  }

  /** Parse one already-decoded transcript entry. Never throws. */
  entryToEvents(entry: Record<string, unknown>): IREvent[] {
    const type = typeof entry.type === "string" ? entry.type : undefined;
    if (type === undefined) return [this.unknown("missing-type", entry)];

    if (this.isDuplicate(entry)) return [];

    switch (type) {
      case "assistant":
        return this.assistantToEvents(entry);
      case "user":
        return this.userToEvents(entry);
      case "system":
        // Known envelope type with a churning `subtype` zoo — surface as
        // unknown only when the subtype is genuinely novel is too eager;
        // treat all as silent (they are CLI-internal bookkeeping).
        return [];
      default:
        if (SILENT_TYPES.has(type)) return [];
        return [this.unknown(type, entry)];
    }
  }

  // --- internals ---------------------------------------------------------

  private isDuplicate(entry: Record<string, unknown>): boolean {
    const uuid = entry.uuid;
    if (typeof uuid !== "string") return false; // nothing to key on — let it through
    if (this.seen.has(uuid)) return true;
    this.seen.add(uuid);
    return false;
  }

  private assistantToEvents(entry: Record<string, unknown>): IREvent[] {
    const message = asRecord(entry.message);
    if (message === undefined) return [this.unknown("assistant-no-message", entry)];
    const blocks = Array.isArray(message.content) ? message.content : [];
    const messageId = asString(message.id);
    const model = asString(message.model);
    const uuid = asString(entry.uuid);
    const observedAt = Date.now();
    const events: IREvent[] = [];
    for (const raw of blocks) {
      const block = asRecord(raw);
      if (block === undefined) {
        events.push(this.unknown("assistant-non-object-block", raw));
        continue;
      }
      const base = {
        sessionId: this.sessionId,
        observedAt,
        surface: "transcript" as const,
        messageId,
        uuid,
      };
      switch (block.type) {
        case "text":
          events.push({
            ...base,
            kind: "message.assistant",
            text: asString(block.text) ?? "",
            model,
          });
          break;
        case "thinking":
          events.push({
            ...base,
            kind: "thinking",
            text: asString(block.thinking) ?? asString(block.text) ?? "",
          });
          break;
        case "tool_use":
          events.push({
            ...base,
            kind: "tool.use",
            toolUseId: asString(block.id),
            name: asString(block.name) ?? "<unknown-tool>",
            input: block.input,
          });
          break;
        default:
          events.push(this.unknown(`assistant-block:${String(block.type)}`, block));
      }
    }
    return events;
  }

  private userToEvents(entry: Record<string, unknown>): IREvent[] {
    const message = asRecord(entry.message);
    if (message === undefined) return [this.unknown("user-no-message", entry)];
    const uuid = asString(entry.uuid);
    const observedAt = Date.now();
    const content = message.content;
    // Plain prompt turn.
    if (typeof content === "string") {
      return [
        {
          kind: "message.user",
          sessionId: this.sessionId,
          observedAt,
          surface: "transcript",
          text: content,
          uuid,
        },
      ];
    }
    // Block content: tool_result entries land as user-role messages.
    if (Array.isArray(content)) {
      const events: IREvent[] = [];
      for (const raw of content) {
        const block = asRecord(raw);
        if (block === undefined) {
          events.push(this.unknown("user-non-object-block", raw));
          continue;
        }
        switch (block.type) {
          case "tool_result":
            events.push({
              kind: "tool.result",
              sessionId: this.sessionId,
              observedAt,
              surface: "transcript",
              toolUseId: asString(block.tool_use_id),
              content: block.content,
              isError: block.is_error === true,
              uuid,
            });
            break;
          case "text":
            events.push({
              kind: "message.user",
              sessionId: this.sessionId,
              observedAt,
              surface: "transcript",
              text: asString(block.text) ?? "",
              uuid,
            });
            break;
          default:
            events.push(this.unknown(`user-block:${String(block.type)}`, block));
        }
      }
      return events;
    }
    return [this.unknown("user-unrecognized-content", entry)];
  }

  private unknown(tag: string, raw: unknown): IREvent {
    recordDrift(this.drift, "transcript", tag);
    this.onDrift?.(tag);
    return {
      kind: "unknown",
      sessionId: this.sessionId,
      observedAt: Date.now(),
      surface: "transcript",
      tag,
      raw,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
