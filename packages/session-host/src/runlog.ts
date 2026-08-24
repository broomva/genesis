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
  /** Minimum ms between two PERSISTED `status` events whose payload is unchanged.
   *  See {@link RunLogger.persist}. 0 disables coalescing (persist every one). */
  statusMinIntervalMs?: number;
}

/** A logger that observes the IR firehose. Wire as the engine `observer`. */
export class RunLogger {
  private readonly dir: string;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly statusMinIntervalMs: number;
  /** Per-session last PERSISTED status: its payload signature + when. */
  private readonly lastStatus = new Map<string, { sig: string; at: number; suppressed: number }>();
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
    // VALIDATED. A non-finite value failed in BOTH directions: NaN made every
    // comparison false so nothing coalesced, and Infinity suppressed every unchanged
    // heartbeat forever. Neither is a configuration anyone would ask for, and both
    // read as working. (codex MAJOR 3)
    const raw = opts.statusMinIntervalMs;
    this.statusMinIntervalMs =
      Number.isFinite(raw) && (raw as number) >= 0 ? (raw as number) : 60_000;
  }

  /** Count of in-flight turn tallies (test/diagnostic — must not leak). */
  pendingTurns(): number {
    return this.turns.size;
  }

  /** Observe one IR event: persist it + emit structured logs. Never throws. */
  observe(event: IREvent): void {
    const ts = this.now();
    this.persist(event, ts);
    this.summarize(event, ts);
  }

  // --- persistence -------------------------------------------------------

  /** Decide whether a `status` event is worth writing — WITHOUT committing anything.
   *
   *  MEASURED, not hypothetical (BRO-2268). One session's trace on the live box
   *  reached 2.4 GB — 1,710,404 records over ~40 days, of which a 500k-line sample
   *  was 100% `kind:"status"`. The statusline is a POLL: it fires roughly every two
   *  seconds for as long as the session lives, and every fire was appended. Those
   *  records also had no reader — `summarize` has no `case "status"`, so they fell to
   *  `default: return`. Pure write amplification at ~60 MB/day/session.
   *
   *  They are not worthless, which is why this coalesces rather than drops: cost,
   *  context-used and CLI version are exactly what you want when explaining a session
   *  after the fact. Every CHANGE is kept; only repeats are suppressed.
   *
   *  DECIDING IS SEPARATE FROM COMMITTING, and that split is the fix for a real
   *  defect rather than tidiness. The first version updated the signature before the
   *  append, so: A persists, B changes `costUsd`, B's append fails, and every
   *  identical B poll afterwards is then suppressed as "already recorded" — losing a
   *  real change that the very next poll could have recovered. Dropping a CHANGE is
   *  the one direction this must never fail in. (codex BLOCKER 1)
   *
   *  `raw` is excluded from the signature: it carries per-poll timing, so including
   *  it would make every event unique and coalesce exactly nothing. */
  private statusDecision(
    event: IREvent,
    ts: number,
  ): { write: boolean; sig: string; suppressed: number } | undefined {
    if (event.kind !== "status") return undefined;
    const sig = JSON.stringify([
      event.model,
      event.costUsd,
      event.contextUsedPct,
      event.cliVersion,
    ]);
    if (this.statusMinIntervalMs <= 0) return { write: true, sig, suppressed: 0 };
    const prev = this.lastStatus.get(event.sessionId);
    if (!prev || prev.sig !== sig) return { write: true, sig, suppressed: prev?.suppressed ?? 0 };
    const elapsed = ts - prev.at;
    // A BACKWARD CLOCK must not suppress. Wall-clock subtraction goes negative across
    // an NTP step or a manual set, and `negative < interval` is true — so the promised
    // bound silently became "until the clock catches up". Out-of-order means we cannot
    // reason about the interval, so we write. (codex MAJOR 1)
    if (elapsed < 0) return { write: true, sig, suppressed: prev.suppressed };
    if (elapsed < this.statusMinIntervalMs) {
      prev.suppressed += 1;
      return { write: false, sig, suppressed: prev.suppressed };
    }
    return { write: true, sig, suppressed: prev.suppressed };
  }

  private persist(event: IREvent, ts: number): void {
    const decision = this.statusDecision(event, ts);
    if (decision && !decision.write) return;
    try {
      if (!this.dirReady) {
        mkdirSync(this.dir, { recursive: true });
        this.dirReady = true;
      }
      const file = join(this.dir, `${safe(event.sessionId)}.jsonl`);
      // `suppressed` is what keeps a POLL STALL diagnosable. Without it, unchanged
      // polls at a 2s cadence and a 45-second freeze of the statusline retain an
      // identical trace, so "nothing changed" and "nothing arrived" became the same
      // record — a diagnostic the uncoalesced trace could express and this could not.
      // With it, a reader divides the wall-clock gap by the count: ~29 suppressed over
      // a minute is a healthy quiet session, ~1 is a stall. (codex MAJOR 2)
      const record =
        decision !== undefined
          ? { ts, ...event, suppressed: decision.suppressed }
          : { ts, ...event };
      appendFileSync(file, `${JSON.stringify(record)}\n`);
      // COMMIT ONLY ON SUCCESS. Before the append, a failure still advanced the
      // signature and silently swallowed a real change.
      if (decision)
        this.lastStatus.set(event.sessionId, { sig: decision.sig, at: ts, suppressed: 0 });
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
        // Reclaim a turn tally for a session that died mid-turn (P20 #1) — a
        // crash/end before turn.complete would otherwise orphan the entry.
        if (event.phase === "ended" || event.phase === "crashed") {
          this.turns.delete(event.sessionId);
          // Same leak shape the turn tally above was fixed for: this map is keyed by
          // sessionId and would otherwise grow for the life of the process.
          this.lastStatus.delete(event.sessionId);
        }
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
