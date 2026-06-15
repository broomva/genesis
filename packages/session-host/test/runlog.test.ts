import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
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
