import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IREvent } from "../src/ir";
import { RunLogger } from "../src/runlog";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gen-runlog-"));
  const lines: string[] = [];
  let t = 1000;
  const logger = new RunLogger({ dir, log: (l) => lines.push(l), now: () => t++ });
  return { dir, lines, logger };
}

const ev = (sessionId: string, e: Partial<IREvent> & { kind: IREvent["kind"] }): IREvent =>
  ({ sessionId, observedAt: 1, surface: "hook", ...e }) as IREvent;

function traceFor(dir: string, sessionId: string): Record<string, unknown>[] {
  return readFileSync(join(dir, `${sessionId}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

describe("RunLogger — JSONL trace", () => {
  test("appends every event with a timestamp to <sessionId>.jsonl", () => {
    const { dir, logger } = setup();
    logger.observe(ev("s1", { kind: "message.user", text: "hi" } as IREvent));
    logger.observe(
      ev("s1", { kind: "tool.use", name: "Bash", input: { command: "ls" } } as IREvent),
    );
    logger.observe(ev("s1", { kind: "turn.complete" } as IREvent));
    const trace = traceFor(dir, "s1");
    expect(trace.map((e) => e.kind)).toEqual(["message.user", "tool.use", "turn.complete"]);
    expect(typeof trace[0]?.ts).toBe("number");
  });

  test("separate sessions get separate trace files; sessionId is path-sanitized", () => {
    const { dir, logger } = setup();
    logger.observe(ev("telegram:547", { kind: "message.user", text: "a" } as IREvent));
    logger.observe(ev("other", { kind: "message.user", text: "b" } as IREvent));
    expect(traceFor(dir, "telegram_547").length).toBe(1); // ":" sanitized to "_"
    expect(traceFor(dir, "other").length).toBe(1);
  });
});

describe("RunLogger — structured console summary", () => {
  test("turn boundary + tool + done summary", () => {
    const { lines, logger } = setup();
    logger.observe(ev("s2", { kind: "message.user", text: "do a thing" } as IREvent));
    logger.observe(ev("s2", { kind: "tool.use", name: "Bash", input: {} } as IREvent));
    logger.observe(ev("s2", { kind: "message.assistant", text: "done!" } as IREvent));
    logger.observe(ev("s2", { kind: "turn.complete" } as IREvent));
    const joined = lines.join("\n");
    expect(joined).toContain("▶ turn: do a thing");
    expect(joined).toContain("⚙ Bash");
    expect(joined).toMatch(/✓ turn complete .*tools=1 chars=5/);
  });

  test("NO-output turn is flagged loudly with context (the '(no output)' case)", () => {
    const { lines, logger } = setup();
    logger.observe(ev("s3", { kind: "message.user", text: "q" } as IREvent));
    logger.observe(ev("s3", { kind: "tool.use", name: "Read", input: {} } as IREvent));
    logger.observe(ev("s3", { kind: "turn.complete" } as IREvent)); // no assistant text
    const joined = lines.join("\n");
    expect(joined).toContain("NO assistant output");
    expect(joined).toContain("tools=1");
  });

  test("errors and tool errors are surfaced", () => {
    const { lines, logger } = setup();
    logger.observe(ev("s4", { kind: "error", message: "send not acknowledged" } as IREvent));
    logger.observe(ev("s4", { kind: "tool.result", content: "boom", isError: true } as IREvent));
    const joined = lines.join("\n");
    expect(joined).toContain("✖ ERROR: send not acknowledged");
    expect(joined).toContain("✖ tool error: boom");
  });

  test("drift (unknown) and lifecycle are logged", () => {
    const { lines, logger } = setup();
    logger.observe(
      ev("s5", { kind: "unknown", surface: "transcript", tag: "future-thing" } as IREvent),
    );
    logger.observe(
      ev("s5", {
        kind: "session.lifecycle",
        phase: "ready",
        transcriptPath: "/t.jsonl",
      } as IREvent),
    );
    const joined = lines.join("\n");
    expect(joined).toContain("◆ drift(transcript): future-thing");
    expect(joined).toContain("session ready");
  });

  test("turn tally is reclaimed when a session ends/crashes mid-turn (P20 #1 leak)", () => {
    const { logger } = setup();
    // open a turn but never complete it (a session that dies mid-turn)
    logger.observe(ev("s7", { kind: "message.user", text: "work" } as IREvent));
    expect(logger.pendingTurns()).toBe(1);
    // crash/end before turn.complete must reclaim the entry (was the leak)
    logger.observe(ev("s7", { kind: "session.lifecycle", phase: "crashed" } as IREvent));
    expect(logger.pendingTurns()).toBe(0);
    // and a normal turn.complete also reclaims
    logger.observe(ev("s8", { kind: "message.user", text: "x" } as IREvent));
    logger.observe(ev("s8", { kind: "turn.complete" } as IREvent));
    expect(logger.pendingTurns()).toBe(0);
  });

  test("persist failure never throws (observability can't break the session)", () => {
    const logger = new RunLogger({ dir: "/proc/nonexistent/cannot-mkdir", log: () => {} });
    expect(() => logger.observe(ev("s6", { kind: "turn.complete" } as IREvent))).not.toThrow();
  });
});

/**
 * BRO-2268 — status coalescing.
 *
 * Found by watching the live box, not by reading code: one session's trace had
 * reached 2.4 GB — 1,710,404 records spanning ~40 days, and a 500k-line sample was
 * 100% `kind:"status"`. The statusline is a POLL firing roughly every two seconds
 * for the life of a session, and every fire was appended (~60 MB/day/session).
 *
 * They also had no reader: `summarize` has no `case "status"`, so they fell to
 * `default: return`. Persisted forever, summarised never.
 *
 * Coalesced rather than dropped — cost/context/CLI version are exactly what explains
 * a session after the fact. Every CHANGE is kept; only repeats of an unchanged
 * payload are suppressed, and a heartbeat still lands so a quiet stretch stays
 * distinguishable from a gap.
 */
describe("RunLogger — status coalescing (BRO-2268)", () => {
  const status = (sessionId: string, over: Record<string, unknown> = {}) =>
    ({
      sessionId,
      observedAt: 1,
      surface: "statusline",
      kind: "status",
      model: "Opus",
      costUsd: 1,
      contextUsedPct: 5,
      cliVersion: "2.1.191",
      raw: { poll: Math.random() },
      ...over,
    }) as unknown as IREvent;

  function coalescing(statusMinIntervalMs = 60_000) {
    const dir = mkdtempSync(join(tmpdir(), "gen-runlog-c-"));
    let t = 0;
    const logger = new RunLogger({
      dir,
      log: () => {},
      now: () => t,
      statusMinIntervalMs,
    });
    const at = (ms: number) => {
      t = ms;
    };
    return { dir, logger, at };
  }

  test("an unchanged status poll is written ONCE, not once per poll", () => {
    const { dir, logger, at } = coalescing();
    // 60 polls two seconds apart — the real cadence — inside one interval.
    for (let i = 0; i < 60; i++) {
      at(i * 2_000);
      logger.observe(status("s1"));
    }
    // 0ms and 60_000ms qualify; the 58 between them are repeats.
    expect(traceFor(dir, "s1").length).toBe(2);
  });

  test("`raw` alone changing does NOT defeat coalescing", () => {
    // raw carries per-poll timing, so including it in the signature would make every
    // event unique and coalesce nothing — the bug this fix would have shipped with.
    const { dir, logger, at } = coalescing();
    at(0);
    logger.observe(status("s1", { raw: { a: 1 } }));
    at(1_000);
    logger.observe(status("s1", { raw: { a: 2 } }));
    expect(traceFor(dir, "s1").length).toBe(1);
  });

  test.each([
    ["costUsd", { costUsd: 2 }],
    ["contextUsedPct", { contextUsedPct: 9 }],
    ["model", { model: "Sonnet" }],
    ["cliVersion", { cliVersion: "2.2.0" }],
  ])("a CHANGE in %s is always kept", (_name, over) => {
    const { dir, logger, at } = coalescing();
    at(0);
    logger.observe(status("s1"));
    at(1_000); // well inside the interval — kept because the payload moved
    logger.observe(status("s1", over));
    expect(traceFor(dir, "s1").length).toBe(2);
  });

  test("a heartbeat still lands, so a quiet stretch is not a gap", () => {
    const { dir, logger, at } = coalescing(10_000);
    for (const ms of [0, 5_000, 10_000, 15_000, 20_000]) {
      at(ms);
      logger.observe(status("s1"));
    }
    expect(traceFor(dir, "s1").length).toBe(3); // 0, 10_000, 20_000
  });

  test("sessions coalesce independently", () => {
    const { dir, logger, at } = coalescing();
    at(0);
    logger.observe(status("s1"));
    at(1_000);
    logger.observe(status("s2")); // same payload, DIFFERENT session — must be kept
    expect(traceFor(dir, "s1").length).toBe(1);
    expect(traceFor(dir, "s2").length).toBe(1);
  });

  test("NON-status events are never coalesced", () => {
    const { dir, logger, at } = coalescing();
    for (let i = 0; i < 5; i++) {
      at(i);
      logger.observe(ev("s1", { kind: "message.assistant", text: "same" } as IREvent));
    }
    expect(traceFor(dir, "s1").length).toBe(5);
  });

  test("statusMinIntervalMs=0 disables coalescing entirely", () => {
    const { dir, logger, at } = coalescing(0);
    for (let i = 0; i < 5; i++) {
      at(i);
      logger.observe(status("s1"));
    }
    expect(traceFor(dir, "s1").length).toBe(5);
  });

  test("the per-session signature map is released when the session ends", () => {
    // Same leak shape the turn tally was fixed for: keyed by sessionId, it would
    // otherwise grow for the life of the process.
    const { logger, at } = coalescing();
    at(0);
    logger.observe(status("s1"));
    logger.observe(ev("s1", { kind: "session.lifecycle", phase: "ended" } as IREvent));
    const held = (logger as unknown as { lastStatus: Map<string, unknown> }).lastStatus;
    expect(held.size).toBe(0);
  });
});

/**
 * BRO-2268 round 2 — the failure modes cross-model review found, each simulated.
 *
 * The first version of this feature passed every test it had and still contained a
 * blocker: it advanced the coalescing signature BEFORE the append, so a failed write
 * of a CHANGED status made every identical poll afterwards look already-recorded.
 * Dropping a change is the one direction this must never fail in, and no test
 * exercised a failing append.
 */
describe("RunLogger — status coalescing failure modes (BRO-2268)", () => {
  const status = (sessionId: string, over: Record<string, unknown> = {}) =>
    ({
      sessionId,
      observedAt: 1,
      surface: "statusline",
      kind: "status",
      model: "Opus",
      costUsd: 1,
      contextUsedPct: 5,
      cliVersion: "2.1.191",
      raw: {},
      ...over,
    }) as unknown as IREvent;

  function harness(statusMinIntervalMs = 60_000) {
    const dir = mkdtempSync(join(tmpdir(), "gen-runlog-f-"));
    let t = 0;
    const logged: string[] = [];
    const logger = new RunLogger({
      dir,
      log: (l) => logged.push(l),
      now: () => t,
      statusMinIntervalMs,
    });
    const at = (ms: number) => {
      t = ms;
    };
    return { dir, logger, at, logged, file: join(dir, "s1.jsonl") };
  }

  // THE BLOCKER. A changed status whose append fails must remain un-committed, so the
  // next identical poll still records it.
  test("a FAILED append does not commit the signature — the change is recovered", () => {
    const { dir, logger, at, file } = harness();
    at(0);
    logger.observe(status("s1", { costUsd: 1 })); // A persists
    chmodSync(file, 0o444); // make the append fail
    at(1_000);
    logger.observe(status("s1", { costUsd: 2 })); // B changes, append FAILS
    chmodSync(file, 0o644); // writes work again
    at(2_000);
    logger.observe(status("s1", { costUsd: 2 })); // identical B — must NOT be suppressed
    const costs = traceFor(dir, "s1").map((r) => r.costUsd);
    expect(costs).toEqual([1, 2]); // the change survived a failed write
  });

  test("the failed append is reported, not swallowed silently", () => {
    const { logger, at, logged, file } = harness();
    at(0);
    logger.observe(status("s1"));
    chmodSync(file, 0o444);
    at(70_000);
    logger.observe(status("s1"));
    chmodSync(file, 0o644);
    expect(logged.some((l) => l.includes("runlog persist failed"))).toBe(true);
  });

  // MAJOR 1. Wall-clock subtraction goes negative across an NTP step, and
  // `negative < interval` is true — so the 60s bound silently became "until the clock
  // catches up".
  test("a BACKWARD clock persists rather than suppressing", () => {
    const { dir, logger, at } = harness();
    at(100_000);
    logger.observe(status("s1"));
    at(10_000); // clock stepped backwards
    logger.observe(status("s1")); // unchanged payload, but time is unreasonable
    expect(traceFor(dir, "s1").length).toBe(2);
  });

  // MAJOR 2. Without a suppressed count, unchanged 2s polls and a 45s freeze retain
  // an identical trace — "nothing changed" and "nothing arrived" collapse together.
  test("the retained record carries how many polls it stands for", () => {
    const { dir, logger, at } = harness(60_000);
    for (let i = 0; i < 31; i++) {
      at(i * 2_000); // 0 … 60_000 at the real 2s cadence
      logger.observe(status("s1"));
    }
    const rows = traceFor(dir, "s1");
    expect(rows.length).toBe(2);
    expect(rows[0]?.suppressed).toBe(0);
    expect(rows[1]?.suppressed).toBe(29); // a healthy quiet minute
  });

  test("a poll STALL is distinguishable from a quiet session", () => {
    const { dir, logger, at } = harness(60_000);
    at(0);
    logger.observe(status("s1"));
    at(61_000); // one poll after a ~minute of silence: the statusline stalled
    logger.observe(status("s1"));
    const rows = traceFor(dir, "s1");
    expect(rows[1]?.suppressed).toBe(0); // vs 29 above, over the same wall-clock gap
  });

  // MAJOR 3. Non-finite config failed in BOTH directions and read as working.
  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative-infinity", Number.NEGATIVE_INFINITY],
  ])("a non-finite interval (%s) falls back to the default", (_n, v) => {
    const { dir, logger, at } = harness(v as number);
    // MUST cross the 60s default, or the Infinity arm is vacuous: without a poll at
    // or beyond the boundary, "unvalidated Infinity" and "validated 60s" retain the
    // same single record and the test passes under the defect it exists to catch.
    // (codex MINOR 2 — the arm was exactly that before this line.)
    for (const ms of [0, 1_000, 2_000, 60_000, 61_000, 120_000]) {
      at(ms);
      logger.observe(status("s1"));
    }
    // Validated 60s keeps 0, 60_000, 120_000. Unvalidated: NaN keeps all six
    // (every comparison false), Infinity keeps only the first.
    expect(traceFor(dir, "s1").length).toBe(3);
  });
});
