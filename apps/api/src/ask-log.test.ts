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
import { readBounded } from "./server";

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
      `createAskLog(dir).answer({ threadId: "thread-1", id: "ask-1", answer: "Yes", answeredAt: "2026-08-31T12:05:00.000Z" });`,
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
    log.answer({
      threadId: "thread-1",
      id: "ask-1",
      answer: "Yes",
      answeredAt: "2026-08-31T12:05:00.000Z",
    });
    log.answer({
      threadId: "thread-1",
      id: "ask-1",
      answer: "Yes",
      answeredAt: "2026-08-31T12:05:00.000Z",
    });

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
    log.answer({
      threadId: "thread-1",
      id: "ask-1",
      answer: "Yes",
      answeredAt: "2026-08-31T12:05:00.000Z",
    });
    log.answer({
      threadId: "thread-1",
      id: "ask-1",
      answer: "No",
      answeredAt: "2026-08-31T12:06:00.000Z",
    });
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
    // BYTE-HONEST, and that is the whole point of this spy. The previous version
    // took a string and returned `str.length` — UTF-16 CODE UNITS — which is
    // exactly the confusion the code under test had. An instrument that shares
    // the defect it is meant to detect cannot report it at any input, and this
    // one could not: the loop it guards was silently corrupting every non-ASCII
    // record and the test was green.
    const wrote: Buffer[] = [];
    const shortFs: DurableFs = {
      openSync: () => 7,
      writeSync: (_fd, data) => {
        const n = first ? Math.floor(data.byteLength / 2) : data.byteLength;
        first = false;
        wrote.push(Buffer.from(data.subarray(0, n)));
        return n;
      },
      fsyncSync: () => {},
      closeSync: () => {},
    };
    const a = ask();
    createAskLog(dir, shortFs).append(a);
    const assembled = Buffer.concat(wrote).toString("utf8");
    expect(assembled).toBe(`${JSON.stringify(a)}\n`);
    // Specifically: it ends in a newline. That is the property whose absence
    // destroys the NEXT record.
    expect(assembled.endsWith("\n")).toBe(true);
    expect(wrote.length).toBeGreaterThan(1); // it really did take two writes
  });

  test("a NON-ASCII record survives a short write — bytes, not code units", () => {
    // THE TEST THAT COULD NOT EXIST BEFORE. `writeSync` returns a BYTE count and
    // the loop resumed with a UTF-16 CODE UNIT offset. Identical for ASCII, which
    // is why every fixture here passed while the loop silently corrupted anything
    // else. Measured against the old code with a byte-honest spy and a 10-byte
    // short write:
    //   "€€€ Wire €40.000 — approve?"  ->  "€€re €40.0 — appro?"
    // 123 of 133 bytes, characters dropped from the MIDDLE of the operator's
    // question — and still valid JSON, so the reader accepts it. Silent
    // corruption, worse than the glued-line loss the loop exists to prevent.
    const chunks: Buffer[] = [];
    const tenBytesAtATime: DurableFs = {
      openSync: () => 9,
      writeSync: (_fd, data) => {
        const n = Math.min(10, data.byteLength);
        chunks.push(Buffer.from(data.subarray(0, n)));
        return n;
      },
      fsyncSync: () => {},
      closeSync: () => {},
    };
    const q = "€€€ Wire €40.000 — approve?";
    createAskLog(dir, tenBytesAtATime).append(ask({ question: q }));
    const assembled = Buffer.concat(chunks).toString("utf8");
    // Round-trips as JSON AND carries the question verbatim. Asserting only that
    // it parses would pass on a truncation that happened to stay valid.
    expect(JSON.parse(assembled.trim())).toMatchObject({ question: q });
    expect(Buffer.byteLength(assembled)).toBe(
      Buffer.byteLength(`${JSON.stringify(ask({ question: q }))}\n`),
    );
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

  test('a non-string threadId is SKIPPED, not coerced to thread ""', () => {
    // POLICY CHANGED DELIBERATELY, and this test used to pin the opposite.
    //
    // It was written for a real bug — the filter compared the RAW value while the
    // output coerced to "", so an entry was visible unfiltered and reachable by no
    // `?thread=`. The fix made both sides use the coerced value. That closed the
    // reachability hole and opened a worse one: a record with no thread became a
    // record in thread "", indistinguishable from a genuine one, and could then
    // collide with a real ask under the same id without triggering the ambiguity
    // rule. Reproduced through the real routes, an operator answering "Approve the
    // staging rebuild?" recorded APPROVED against "Wire $40,000 to vendor X?".
    //
    // An ask that states no thread is UNROUTABLE — it cannot be shown in a thread
    // and an answer to it cannot be attributed — so it is malformed, like a record
    // with no id or no question, and it is skipped and counted rather than served
    // under a fabricated thread. The reachability bug this test was written for
    // cannot recur, because nothing unreachable is emitted at all.
    writeFileSync(
      join(dir, ASK_FILE),
      `${JSON.stringify({ id: "n", sessionId: "s", threadId: null, question: "q?", createdAt: "x" })}\n`,
    );
    const r = readAsks(dir);
    expect(r.entries).toHaveLength(0);
    expect(r.degraded).toContain("1 ask record(s) skipped");
    // And it is not hiding under the empty thread either.
    expect(readAsks(dir, { threadId: "" }).entries).toHaveLength(0);
  });

  test("both journals unreadable reports BOTH, not just the last", () => {
    const log = createAskLog(dir);
    log.append(ask());
    log.answer({ threadId: "thread-1", id: "ask-1", answer: "Yes", answeredAt: "x" });
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

describe("answeredAt is typed, not trusted", () => {
  test("a numeric answeredAt does not round-trip as a string field", () => {
    // The ONE unchecked field: `answeredAt: 12345` was emitted under a declared
    // `answeredAt?: string`. Every other field is guarded three lines away.
    const log = createAskLog(dir);
    log.append(ask());
    writeFileSync(
      join(dir, ANSWER_FILE),
      // threadId PRESENT, deliberately. Without it `isAnswer` rejects this row on
      // the thread check and never reaches the answeredAt check — so the mutant
      // that removes the answeredAt guard survived, its own fixture having become
      // unreachable when the key gained a field. The row must be well-formed in
      // every respect EXCEPT the one under test.
      `${JSON.stringify({ threadId: "thread-1", id: "ask-1", answer: "Yes", answeredAt: 12345 })}\n`,
    );
    const e = readAsks(dir, { includeAnswered: true }).entries[0];
    // The malformed row is rejected wholesale, so the ask stays pending rather
    // than becoming "answered" with a number where a timestamp belongs.
    expect(e?.status).toBe("pending");
    expect(e?.answeredAt).toBeUndefined();
  });

  test("a well-formed answeredAt still works", () => {
    const log = createAskLog(dir);
    log.append(ask());
    log.answer({
      threadId: "thread-1",
      id: "ask-1",
      answer: "Yes",
      answeredAt: "2026-08-31T12:00:00.000Z",
    });
    expect(readAsks(dir, { includeAnswered: true }).entries[0]?.answeredAt).toBe(
      "2026-08-31T12:00:00.000Z",
    );
  });
});

// A malformed ask must not be indistinguishable from no ask. This whole block
// exists because DOGFOODING found what the suite could not: every fixture above
// is built by `append`, which is typed, so no test in this file could ever
// produce a record with a missing field. Hand-writing one through the live route
// did — it came back as a well-formed ask with `createdAt: ""`, `degraded`
// absent. (P11 — BRO-2387.)
describe("readAsks accounts for malformed records", () => {
  test("a record with no id is counted, not silently dropped", () => {
    writeFileSync(
      join(dir, ASK_FILE),
      `${JSON.stringify({ sessionId: "s", threadId: "t", question: "Q?", createdAt: "2026-08-31T12:00:00.000Z" })}\n`,
    );
    const r = readAsks(dir);
    expect(r.entries).toHaveLength(0);
    // The COUNT is the assertion, not merely "degraded is set": a message that
    // does not name how many records vanished cannot be acted on.
    expect(r.degraded).toContain("1 ask record(s) skipped");
  });

  test("a record with no question is counted", () => {
    writeFileSync(
      join(dir, ASK_FILE),
      `${JSON.stringify({ id: "a1", sessionId: "s", createdAt: "2026-08-31T12:00:00.000Z" })}\n`,
    );
    expect(readAsks(dir).degraded).toContain("1 ask record(s) skipped");
  });

  test("the count is the number of bad records, not a boolean", () => {
    writeFileSync(
      join(dir, ASK_FILE),
      `${JSON.stringify({ question: "A?" })}\n${JSON.stringify({ question: "B?" })}\n${JSON.stringify({ question: "C?" })}\n`,
    );
    // Mutating `skipped++` to `skipped = 1` must fail here. With a boolean
    // `degraded` flag it would not.
    expect(readAsks(dir).degraded).toContain("3 ask record(s) skipped");
  });

  test("the exact shape dogfooding produced: askedAt instead of createdAt", () => {
    writeFileSync(
      join(dir, ASK_FILE),
      `${JSON.stringify({ id: "ask-1", threadId: "t-alpha", question: "Ship or hold?", askedAt: "2026-08-31T12:00:00.000Z" })}\n`,
    );
    const r = readAsks(dir);
    // STILL SERVED. Dropping it would turn a partial write into an absent ask,
    // which is the worse failure — the operator would never see the question.
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.createdAt).toBe("");
    // ...but the client is told the record was incomplete.
    expect(r.degraded).toContain("1 ask record(s) missing sessionId or createdAt");
  });

  test("sessionId present, createdAt missing — still counted", () => {
    // The two halves of the incomplete check must be INDEPENDENTLY killable.
    // With only this and the both-missing case, a mutant deleting the createdAt
    // half survives, because every other fixture is missing sessionId too.
    writeFileSync(
      join(dir, ASK_FILE),
      `${JSON.stringify({ id: "a1", sessionId: "s", threadId: "t", question: "Q?" })}\n`,
    );
    expect(readAsks(dir).degraded).toContain("1 ask record(s) missing");
  });

  test("createdAt present, sessionId missing — still counted", () => {
    writeFileSync(
      join(dir, ASK_FILE),
      `${JSON.stringify({ id: "a1", threadId: "t", question: "Q?", createdAt: "2026-08-31T12:00:00.000Z" })}\n`,
    );
    expect(readAsks(dir).degraded).toContain("1 ask record(s) missing");
  });

  test("a line that is valid JSON but not an object is counted", () => {
    // `"hello"` and `42` parse fine and reach the loop as non-objects. Before
    // this they hit a bare `continue`.
    writeFileSync(join(dir, ASK_FILE), '"hello"\n42\nnull\n');
    const r = readAsks(dir);
    expect(r.entries).toHaveLength(0);
    expect(r.degraded).toContain("3 ask record(s) skipped");
  });

  test("a record missing BOTH sessionId and createdAt counts once, not twice", () => {
    writeFileSync(
      join(dir, ASK_FILE),
      `${JSON.stringify({ id: "a1", threadId: "t", question: "Q?" })}\n`,
    );
    expect(readAsks(dir).degraded).toContain("1 ask record(s) missing");
  });

  test("a well-formed log reports NOTHING degraded", () => {
    // The negative control. Without this the two counters could fire on every
    // read and every assertion above would still pass.
    const log = createAskLog(dir);
    log.append(ask());
    log.append(ask({ id: "ask-2" }));
    const r = readAsks(dir);
    expect(r.entries).toHaveLength(2);
    expect(r.degraded).toBeUndefined();
  });

  test("both counters travel together, and the unreadable-file message survives", () => {
    writeFileSync(
      join(dir, ASK_FILE),
      `${JSON.stringify({ question: "no id" })}\n${JSON.stringify({ id: "a2", threadId: "t", question: "Q?" })}\n`,
    );
    writeFileSync(join(dir, ANSWER_FILE), "{}\n");
    chmodSync(join(dir, ANSWER_FILE), 0o000);
    const d = readAsks(dir).degraded ?? "";
    chmodSync(join(dir, ANSWER_FILE), 0o644);
    // Accumulation, not overwrite — the property the earlier `degraded = m` bug
    // broke. All three problems must be present in one string.
    expect(d).toContain("answers.jsonl could not be read");
    expect(d).toContain("1 ask record(s) skipped");
    expect(d).toContain("1 ask record(s) missing");
  });

  test("a filtered read still reports records the filter never reached", () => {
    // A malformed record has no trustworthy threadId, so it is counted BEFORE
    // the thread filter. Over-reporting is the safe direction: a client asking
    // about one thread is told the log is incomplete rather than shown a clean
    // partial view.
    writeFileSync(
      join(dir, ASK_FILE),
      `${JSON.stringify({ question: "no id" })}\n${JSON.stringify({ id: "a2", sessionId: "s", threadId: "t-alpha", question: "Q?", createdAt: "2026-08-31T12:00:00.000Z" })}\n`,
    );
    const r = readAsks(dir, { threadId: "t-alpha" });
    expect(r.entries).toHaveLength(1);
    expect(r.degraded).toContain("1 ask record(s) skipped");
  });
});

// readBounded is the actual body cap. Its unit is BYTES, and the distinction is
// not academic: an answer of multi-byte characters is under the character cap
// while being several times over the byte budget the guard exists to protect.
describe("readBounded", () => {
  const reqOf = (bytes: Uint8Array) =>
    new Request("http://x", {
      method: "POST",
      body: bytes,
    });

  test("a body at exactly the cap is returned", async () => {
    const r = await readBounded(reqOf(new Uint8Array(100).fill(0x61)), 100);
    expect(r).toHaveLength(100);
  });

  test("one byte over the cap returns null", async () => {
    // Off-by-one in the other direction is the failure that makes the cap a
    // rounding error rather than a bound.
    expect(await readBounded(reqOf(new Uint8Array(101).fill(0x61)), 100)).toBeNull();
  });

  test("the cap counts BYTES, not characters", async () => {
    // 40 three-byte characters = 120 bytes. Under a 100-CHARACTER cap, over a
    // 100-BYTE one. A `.length` check on the decoded string would pass this.
    const body = new TextEncoder().encode("€".repeat(40));
    expect(body.byteLength).toBe(120);
    expect(await readBounded(reqOf(body), 100)).toBeNull();
  });

  test("an empty body is an empty string, not null", async () => {
    // null means "too large" and must not double as "absent" — the route turns
    // one into a 413 and the other into a 400.
    expect(await readBounded(new Request("http://x", { method: "POST" }), 100)).toBe("");
  });

  test("the stream is CANCELLED past the cap, not merely abandoned", async () => {
    // Returning early without cancelling leaves the producer and its buffers
    // alive — the exact resource the cap exists to protect. The mutation sweep
    // found this: removing `await reader.cancel()` survived every other test
    // here, because they all check the RETURN VALUE and none checks the stream.
    let cancelled = false;
    // FINITE, and that is not incidental. An endless stream makes the
    // "cap never trips" mutant loop forever, which hangs the whole sweep
    // rather than reporting a verdict — a mutation harness that can hang is
    // one that stops producing verdicts. Five 64-byte chunks: past the cap on
    // the second, and terminating even with the cap disabled.
    let pulls = 0;
    const stream = new ReadableStream({
      pull(ctrl) {
        if (++pulls > 5) return ctrl.close();
        ctrl.enqueue(new Uint8Array(64).fill(0x61));
      },
      cancel() {
        cancelled = true;
      },
    });
    const r = await readBounded({ body: stream } as unknown as Request, 100);
    expect(r).toBeNull();
    expect(cancelled).toBe(true);
  });
});
