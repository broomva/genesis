// The fsync, asserted rather than asserted-in-prose.
//
// ask-log.test.ts's subprocess tests prove cross-process durability: the writer
// exits, another process reads the bytes. They CANNOT catch the fsync being
// removed, because the page cache is visible across processes — a plain
// appendFileSync passes every one of them. The mutation sweep confirmed exactly
// that: "fsync removed (page cache only)" SURVIVED the whole suite. Without this
// file the guarantee voice-queue.ts:61-71 demands would be deletable by anyone,
// with nothing going red.
//
// The first version of this file used `mock.module("node:fs")`. That was wrong
// and expensively so: `bun test` runs every file in ONE process, so the mock
// leaked into every file loaded after it and took the full suite from 0 to 126
// failures. Worse, the two-file check written to prove it did not leak PASSED —
// two files is a favourable ordering, so the check was a false negative about
// its own subject.
//
// So the seam is an injected `DurableFs` instead. No global state, no ordering
// dependence, and the assertion still bites: the call SEQUENCE lives in
// durableAppend, so removing `fsyncSync` there breaks these regardless of what
// is injected.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DurableFs, createAskLog } from "./ask-log";

let dir: string;
let calls: string[];
let opened: [string, string][];

const spy = (): DurableFs => ({
  openSync: (p, flags) => {
    opened.push([p, flags]);
    calls.push("open");
    return 42;
  },
  writeSync: (_fd, s) => {
    calls.push(`write:${s.trim()}`);
    return s.length;
  },
  fsyncSync: (fd) => {
    calls.push(`fsync:${fd}`);
  },
  closeSync: (fd) => {
    calls.push(`close:${fd}`);
  },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ask-fsync-"));
  calls = [];
  opened = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ask = {
  id: "a1",
  sessionId: "s",
  threadId: "t",
  question: "q?",
  createdAt: "2026-08-31T00:00:00.000Z",
};

describe("every append reaches the platter, not just the page cache", () => {
  test("append: open, write, fsync, close — in that order", () => {
    createAskLog(dir, spy()).append(ask);
    expect(calls).toEqual(["open", `write:${JSON.stringify(ask)}`, "fsync:42", "close:42"]);
  });

  test("fsync happens BEFORE close — closing a fd does not flush", () => {
    createAskLog(dir, spy()).append(ask);
    expect(calls.indexOf("fsync:42")).toBeLessThan(calls.indexOf("close:42"));
  });

  test("answer gets the same guarantee — a vanished ack is worse than none", () => {
    createAskLog(dir, spy()).answer({
      id: "a1",
      answer: "Yes",
      answeredAt: "2026-08-31T00:01:00.000Z",
    });
    expect(calls.filter((c) => c.startsWith("fsync"))).toEqual(["fsync:42"]);
    expect(calls.indexOf("fsync:42")).toBeLessThan(calls.indexOf("close:42"));
  });

  test("opened for append, never truncating — the log is append-only", () => {
    createAskLog(dir, spy()).append(ask);
    expect(opened.map(([, flags]) => flags)).toEqual(["a"]);
  });

  test("the fd is closed even when the write throws", () => {
    const boom: DurableFs = {
      ...spy(),
      writeSync: () => {
        throw new Error("ENOSPC");
      },
    };
    expect(() => createAskLog(dir, boom).append(ask)).toThrow(/ENOSPC/);
    // The throw propagates — the ask log's failure policy is the voice queue's —
    // and the descriptor is still released.
    expect(calls).toContain("close:42");
  });
});
