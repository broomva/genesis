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
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANSWER_FILE, ASK_FILE, type Ask, type DurableFs, createAskLog, readAsks } from "./ask-log";

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

describe("findings from the P20 review", () => {
  test("a short write is COMPLETED — every byte of the record reaches the file", () => {
    // POSIX write() may write fewer bytes than asked — the ordinary shape of a
    // nearly-full filesystem. Discarding the count left a line with no trailing
    // newline, and the NEXT append landed on it, gluing two records into one
    // unparseable line: the reader skips it and BOTH are gone.
    //
    // The first version of this test asserted `not.toThrow()`, which passes
    // whether the loop completes the write or assumes it did — it asserted
    // nothing about the bytes, and the mutation sweep caught it surviving.
    // So it reassembles what the spy actually received.
    let first = true;
    const wrote: string[] = [];
    const shortFs: DurableFs = {
      openSync: () => 7,
      writeSync: (_fd, str) => {
        const n = first ? Math.floor(str.length / 2) : str.length;
        first = false;
        wrote.push(str.slice(0, n));
        return n;
      },
      fsyncSync: () => {},
      closeSync: () => {},
    };
    const a = ask();
    createAskLog(dir, shortFs).append(a);
    const assembled = wrote.join("");
    expect(assembled).toBe(`${JSON.stringify(a)}\n`);
    // Specifically: it ends in a newline. That is the property whose absence
    // destroys the NEXT record.
    expect(assembled.endsWith("\n")).toBe(true);
    expect(wrote.length).toBeGreaterThan(1); // it really did take two writes
  });

  test("a write making no progress throws instead of spinning forever", () => {
    const stuckFs: DurableFs = {
      openSync: () => 7,
      writeSync: () => 0, // no progress, ever
      fsyncSync: () => {},
      closeSync: () => {},
    };
    expect(() => createAskLog(dir, stuckFs).append(ask())).toThrow(/short write/);
  });

  test("the fd is closed even when a short write throws", () => {
    const closed: number[] = [];
    const stuckFs: DurableFs = {
      openSync: () => 7,
      writeSync: () => 0,
      fsyncSync: () => {},
      closeSync: (fd) => {
        closed.push(fd);
      },
    };
    expect(() => createAskLog(dir, stuckFs).append(ask())).toThrow();
    expect(closed).toEqual([7]);
  });

  test("two asks sharing an id in different threads do not mask each other", () => {
    // Dedupe ran BEFORE the thread filter, so the dedupe key was global while
    // the visible universe was per-thread: ?thread=t2 was served t1's question
    // text, or nothing. Cross-thread disclosure.
    const log = createAskLog(dir);
    log.append(ask({ id: "dup", threadId: "t1", question: "Alice: ship it?" }));
    log.append(ask({ id: "dup", threadId: "t2", question: "Bob: DELETE prod?" }));
    expect(readAsks(dir, { threadId: "t1" }).entries.map((e) => e.question)).toEqual([
      "Alice: ship it?",
    ]);
    expect(readAsks(dir, { threadId: "t2" }).entries.map((e) => e.question)).toEqual([
      "Bob: DELETE prod?",
    ]);
  });

  test("malformed options are dropped, not handed to the client as AskOption[]", () => {
    writeFileSync(
      join(dir, ASK_FILE),
      `${JSON.stringify({
        id: "opt",
        sessionId: "s",
        threadId: "t",
        question: "q?",
        createdAt: "x",
        options: [
          1,
          null,
          { label: { nested: true } },
          "str",
          { label: "Yes" },
          { label: "No", description: "d" },
        ],
      })}\n`,
    );
    const e = readAsks(dir).entries[0];
    expect(e?.options).toEqual([{ label: "Yes" }, { label: "No", description: "d" }]);
  });

  test("a non-string threadId is reachable by the value it is emitted as", () => {
    // The filter compared the RAW value while the output coerced to "", so an
    // entry appeared in the unfiltered list and was reachable by no ?thread=.
    writeFileSync(
      join(dir, ASK_FILE),
      `${JSON.stringify({ id: "n", sessionId: "s", threadId: null, question: "q?", createdAt: "x" })}\n`,
    );
    expect(readAsks(dir).entries[0]?.threadId).toBe("");
    expect(readAsks(dir, { threadId: "" }).entries.map((e) => e.id)).toEqual(["n"]);
  });

  test("both journals unreadable reports BOTH, not just the last", () => {
    const log = createAskLog(dir);
    log.append(ask());
    log.answer({ id: "ask-1", answer: "Yes", answeredAt: "x" });
    chmodSync(join(dir, ASK_FILE), 0o000);
    chmodSync(join(dir, ANSWER_FILE), 0o000);
    const { degraded } = readAsks(dir);
    chmodSync(join(dir, ASK_FILE), 0o644);
    chmodSync(join(dir, ANSWER_FILE), 0o644);
    // The answers failure is the one that used to vanish, and it is the more
    // deceptive: it renders every answered ask as pending.
    expect(degraded).toContain(ANSWER_FILE);
    expect(degraded).toContain(ASK_FILE);
  });
});
