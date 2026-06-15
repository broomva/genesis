// RunLogger — full end-to-end session observability (BRO-1519).
//
// The SessionHub emits a typed IR firehose (every message/tool/permission/
// status/turn/lifecycle/error/unknown). Without a sink it's discarded, so a
// failed or stuck session can't be explained after the fact. RunLogger:
//   1. appends EVERY event to a per-session JSONL trace (<dir>/<sessionId>.jsonl)
//      — the complete event-by-event record;
//   2. emits concise STRUCTURED console lines (→ launchd api log) for turn
//      boundaries and, LOUDLY + in detail, every failure / stuck / drift.
//
// No dashboard — the JSONL is the record (cat/jq), the console is the live tail.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IREvent } from "./ir";

export interface RunLoggerOptions {
  /** Directory for per-session JSONL traces. */
  dir: string;
  /** Structured-line sink (default console.log). */
  log?: (line: string) => void;
  /** Wall clock (ms). Injectable for tests. Default Date.now. */
  now?: () => number;
}

/** A logger that observes the IR firehose. Wire as the engine `observer`. */
export class RunLogger {
  private readonly dir: string;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  /** Per-session running tallies for turn summaries. */
  private readonly turns = new Map<
    string,
    { startedAt: number; tools: number; assistantChars: number; lastEvent: string }
  >();
  private dirReady = false;

  constructor(opts: RunLoggerOptions) {
    this.dir = opts.dir;
    this.log = opts.log ?? ((l) => console.log(l));
    this.now = opts.now ?? (() => Date.now());
  }

  /** Observe one IR event: persist it + emit structured logs. Never throws. */
  observe(event: IREvent): void {
    const ts = this.now();
    this.persist(event, ts);
    this.summarize(event, ts);
  }

  // --- persistence -------------------------------------------------------

  private persist(event: IREvent, ts: number): void {
    try {
      if (!this.dirReady) {
        mkdirSync(this.dir, { recursive: true });
        this.dirReady = true;
      }
      const file = join(this.dir, `${safe(event.sessionId)}.jsonl`);
      appendFileSync(file, `${JSON.stringify({ ts, ...event })}\n`);
    } catch (e) {
      // Observability must never break the session.
      this.log(`[genesis] runlog persist failed: ${String(e)}`);
    }
  }

  // --- structured console summary ----------------------------------------

  private summarize(event: IREvent, ts: number): void {
    const sid = short(event.sessionId);
    const t = this.turns.get(event.sessionId);
    if (t) t.lastEvent = event.kind;

    switch (event.kind) {
      case "session.lifecycle":
        this.log(
          `[genesis] [${sid}] session ${event.phase}${event.transcriptPath ? ` · transcript=${event.transcriptPath}` : ""}`,
        );
        return;
      case "message.user":
        // Start of a turn — open a tally.
        this.turns.set(event.sessionId, {
          startedAt: ts,
          tools: 0,
          assistantChars: 0,
          lastEvent: event.kind,
        });
        this.log(`[genesis] [${sid}] ▶ turn: ${preview(event.text)}`);
        return;
      case "tool.use":
        if (t) t.tools += 1;
        this.log(
          `[genesis] [${sid}]   ⚙ ${event.name} ${preview(JSON.stringify(event.input), 80)}`,
        );
        return;
      case "tool.result":
        if (event.isError) {
          this.log(`[genesis] [${sid}]   ✖ tool error: ${preview(String(event.content), 160)}`);
        }
        return;
      case "message.assistant":
        if (t) t.assistantChars += event.text.length;
        return;
      case "permission.request":
        this.log(`[genesis] [${sid}]   🔐 permission asked: ${event.toolName}`);
        return;
      case "permission.resolved":
        this.log(`[genesis] [${sid}]   🔐 ${event.decision} (${event.source})`);
        return;
      case "awaiting":
        this.log(
          `[genesis] [${sid}] … awaiting ${event.what}${event.message ? `: ${preview(event.message)}` : ""}`,
        );
        return;
      case "turn.complete": {
        const dur = t ? ts - t.startedAt : undefined;
        const empty = (t?.assistantChars ?? 0) === 0;
        const summary = `tools=${t?.tools ?? 0} chars=${t?.assistantChars ?? 0}${dur !== undefined ? ` ${(dur / 1000).toFixed(1)}s` : ""}`;
        // No-output detection (the "(no output)" symptom): loud, with context.
        if (empty) {
          this.log(
            `[genesis] [${sid}] ⚠ turn complete with NO assistant output · ${summary} · ` +
              `lastEvent=${t?.lastEvent ?? "?"} — agent ran but produced no text`,
          );
        } else {
          this.log(`[genesis] [${sid}] ✓ turn complete · ${summary}`);
        }
        this.turns.delete(event.sessionId);
        return;
      }
      case "error":
        this.log(
          `[genesis] [${sid}] ✖ ERROR: ${event.message}${event.detail !== undefined ? ` · ${preview(JSON.stringify(event.detail), 200)}` : ""}`,
        );
        return;
      case "unknown":
        // Drift — a CLI-version surface we don't model yet. Worth seeing.
        this.log(`[genesis] [${sid}] ◆ drift(${event.surface}): ${event.tag ?? "?"}`);
        return;
      default:
        return;
    }
  }
}

function safe(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}
function short(id: string): string {
  return id.slice(0, 8);
}
function preview(s: string, max = 100): string {
  const oneline = s.replace(/\s+/g, " ").trim();
  return oneline.length > max ? `${oneline.slice(0, max - 1)}…` : oneline;
}
