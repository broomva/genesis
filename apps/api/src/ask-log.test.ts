// The ask log's DoD is unusual in one respect: item 1 requires an ask to survive a
// PROCESS restart and still be individually ackable — "asserts this across a
// restart, not within one process". No test in this repo did that before. The
// three whose names say "restart" reconstruct a value inside one process, which
// proves the reducer is pure, not that anything reached a disk.
//
// So these spawn real subprocesses. The writer exits before the reader starts, and
// the reader is a different OS process that has never held the data in memory.
//
// WHAT THAT DOES AND DOES NOT PROVE. It proves the bytes left the process and are
// readable by another one — cross-process durability, which is what "survives a
// restart" means operationally. It does NOT prove the fsync reached the platter;
// nothing short of cutting power to the host proves that. The fsync is there
// because voice-queue.ts:61-71 states the rule, and its absence would be invisible
// to every test that can be written. Saying so here rather than letting a green
// suite imply a guarantee it cannot make.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANSWER_FILE, ASK_FILE, type Ask, createAskLog, readAsks } from "./ask-log";

const MODULE = new URL("./ask-log.ts", import.meta.url).pathname;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ask-log-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run code in a SEPARATE bun process, with the module imported fresh. */
function inSubprocess(body: string): { ok: boolean; stderr: string } {
  const src = `const { createAskLog, readAsks } = await import(${JSON.stringify(MODULE)});
const dir = ${JSON.stringify(dir)};
${body}`;
  const p = Bun.spawnSync(["bun", "-e", src]);
  return { ok: p.exitCode === 0, stderr: p.stderr.toString() };
}

const ask = (over: Partial<Ask> = {}): Ask => ({
  id: "ask-1",
  sessionId: "sess-1",
  threadId: "thread-1",
  question: "Deploy to production?",
  options: [{ label: "Yes" }, { label: "No", description: "hold for review" }],
  createdAt: "2026-08-31T12:00:00.000Z",
  ...over,
});

describe("DoD 1 — an ask survives a process restart and is still ackable", () => {
  test("a subprocess writes; this process reads it back", () => {
    const w = inSubprocess(`createAskLog(dir).append(${JSON.stringify(ask())});`);
    expect(w.stderr).toBe("");
    expect(w.ok).toBe(true);

    // Different OS process, never held the ask in memory.
    const { entries } = readAsks(dir);
    expect(entries.map((e) => e.id)).toEqual(["ask-1"]);
    expect(entries[0]?.status).toBe("pending");
    expect(entries[0]?.question).toBe("Deploy to production?");
  });

  test("a THIRD process answers it, and the ask is individually ackable", () => {
    expect(inSubprocess(`createAskLog(dir).append(${JSON.stringify(ask())});`).ok).toBe(true);
    expect(
      inSubprocess(
        `createAskLog(dir).append(${JSON.stringify(ask({ id: "ask-2", question: "Roll back?" }))});`,
      ).ok,
    ).toBe(true);

    // Answering ask-1 must not touch ask-2 — "individually" is the load-bearing word.
    const a = inSubprocess(
      `createAskLog(dir).answer({ id: "ask-1", answer: "Yes", answeredAt: "2026-08-31T12:05:00.000Z" });`,
    );
    expect(a.stderr).toBe("");
    expect(a.ok).toBe(true);

    const pending = readAsks(dir).entries;
    expect(pending.map((e) => e.id)).toEqual(["ask-2"]);

    const all = readAsks(dir, { includeAnswered: true }).entries;
    expect(all.map((e) => `${e.id}:${e.status}`)).toEqual(["ask-1:answered", "ask-2:pending"]);
    expect(all[0]?.answer).toBe("Yes");
  });

  test("the bytes are on disk before the writing process exits", () => {
    // The negative control for the two above: if the write were buffered in the
    // writer and lost on exit, both would fail — but they would fail identically
    // to a bug in readAsks. This one looks at the file itself.
    expect(inSubprocess(`createAskLog(dir).append(${JSON.stringify(ask())});`).ok).toBe(true);
    expect(existsSync(join(dir, ASK_FILE))).toBe(true);
    const raw = readFileSync(join(dir, ASK_FILE), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw.trim()).id).toBe("ask-1");
  });
});

describe("DoD 2 — answering twice is a no-op, not a double effect", () => {
  test("two identical answers leave one answered ask", () => {
    const log = createAskLog(dir);
    log.append(ask());
    log.answer({ id: "ask-1", answer: "Yes", answeredAt: "2026-08-31T12:05:00.000Z" });
    log.answer({ id: "ask-1", answer: "Yes", answeredAt: "2026-08-31T12:05:00.000Z" });

    const all = readAsks(dir, { includeAnswered: true }).entries;
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("answered");
    // Both appends are on disk — the write path stays dumb and append-only.
    // Idempotency is a property of the READ, which is the whole design.
    expect(readFileSync(join(dir, ANSWER_FILE), "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("a CHANGED answer for the same ask takes the later one", () => {
    const log = createAskLog(dir);
    log.append(ask());
    log.answer({ id: "ask-1", answer: "Yes", answeredAt: "2026-08-31T12:05:00.000Z" });
    log.answer({ id: "ask-1", answer: "No", answeredAt: "2026-08-31T12:06:00.000Z" });
    const all = readAsks(dir, { includeAnswered: true }).entries;
    expect(all).toHaveLength(1);
    expect(all[0]?.answer).toBe("No");
  });

  test("a duplicate ASK collapses too — a retried tool call yields a stable id", () => {
    const log = createAskLog(dir);
    log.append(ask());
    log.append(ask());
    expect(readAsks(dir).entries).toHaveLength(1);
  });
});

describe("DoD 5 — the ask log and queue.jsonl are separate stores", () => {
  test("an ask never lands in the voice intake queue", () => {
    createAskLog(dir).append(ask());
    // queue.jsonl is the caller-originated intake file, keyed by an untrusted
    // phone number. AGENTS.md:181-185 forbids merging them by name.
    expect(existsSync(join(dir, "queue.jsonl"))).toBe(false);
    expect(existsSync(join(dir, ASK_FILE))).toBe(true);
  });

  test("a voice ticket in the same directory is not read as an ask", () => {
    writeFileSync(
      join(dir, "queue.jsonl"),
      `${JSON.stringify({ id: "t-1", callerId: "573001234567", request: "call me back", createdAt: "x" })}\n`,
    );
    createAskLog(dir).append(ask());
    const entries = readAsks(dir, { includeAnswered: true }).entries;
    expect(entries.map((e) => e.id)).toEqual(["ask-1"]);
  });
});

describe("reading is tolerant, and says when it is not", () => {
  test("no files yet is a healthy empty, not a degradation", () => {
    const r = readAsks(dir);
    expect(r.entries).toEqual([]);
    expect(r.degraded).toBeUndefined();
  });

  test("a torn final line is skipped, not fatal", () => {
    const log = createAskLog(dir);
    log.append(ask());
    writeFileSync(
      join(dir, ASK_FILE),
      `${readFileSync(join(dir, ASK_FILE), "utf8")}{"id":"ask-2","ques`,
    );
    expect(readAsks(dir).entries.map((e) => e.id)).toEqual(["ask-1"]);
  });

  test("a row with no question is not an ask", () => {
    writeFileSync(join(dir, ASK_FILE), `${JSON.stringify({ id: "x", sessionId: "s" })}\n`);
    expect(readAsks(dir).entries).toEqual([]);
  });

  test("filtering by thread returns only that thread's asks", () => {
    const log = createAskLog(dir);
    log.append(ask({ id: "a", threadId: "t1" }));
    log.append(ask({ id: "b", threadId: "t2" }));
    expect(readAsks(dir, { threadId: "t1" }).entries.map((e) => e.id)).toEqual(["a"]);
  });

  test("oldest first — an operator answers the longest-waiting question", () => {
    const log = createAskLog(dir);
    log.append(ask({ id: "first", createdAt: "2026-08-31T10:00:00.000Z" }));
    log.append(ask({ id: "second", createdAt: "2026-08-31T11:00:00.000Z" }));
    expect(readAsks(dir).entries.map((e) => e.id)).toEqual(["first", "second"]);
  });
});
