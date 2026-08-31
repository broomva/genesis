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
import {
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DurableFs, REAL_FS, createAskLog } from "./ask-log";

let dir: string;
let calls: string[];
let opened: [string, string][];

const spy = (): DurableFs => ({
  openSync: (p, flags) => {
    opened.push([p, flags]);
    calls.push("open");
    return 42;
  },
  writeSync: (_fd, data) => {
    // Bytes in, bytes out — the spy must not reintroduce the code-unit confusion
    // the loop under test was fixed for.
    calls.push(`write:${Buffer.from(data).toString("utf8").trim()}`);
    return data.byteLength;
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
    // PRESENCE FIRST. `indexOf` returns -1 for a missing element and -1 is less
    // than every real index, so the ordering assertion alone passed when there
    // was NO fsync at all. Asserted vacuously in exactly the way this file was
    // written to prevent. (P20 MINOR.)
    expect(calls).toContain("fsync:42");
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

/**
 * The seam tests what is injected. Production uses the DEFAULT.
 *
 * Every assertion above passes with `REAL_FS.fsyncSync` replaced by a no-op —
 * measured: the full suite stayed at 1658 pass, 0 fail, byte-identical to
 * baseline, while production stopped fsyncing entirely. The injected spy proves
 * `durableAppend` calls whatever it is handed in the right order; it says
 * nothing about what the shipping path is handed.
 *
 * A behavioural assertion is not available — no userspace observation
 * distinguishes a real fsync from a no-op. So this pins IDENTITY: the production
 * ops must BE the node:fs syscalls, not merely have their shape. Swap any one
 * for a stub, a wrapper or a logger and this fails.
 */
describe("the production default is the real syscalls, not a lookalike", () => {
  test("REAL_FS is exactly node:fs", () => {
    expect(REAL_FS.openSync).toBe(openSync);
    expect(REAL_FS.writeSync).toBe(writeSync);
    expect(REAL_FS.fsyncSync).toBe(fsyncSync);
    expect(REAL_FS.closeSync).toBe(closeSync);
  });

  test("createAskLog uses REAL_FS when nothing is injected", () => {
    // Identity above is worthless if the default parameter points elsewhere.
    // Written for real, on disk, with no spy — if the default were a stub that
    // wrote nothing, the file would not exist.
    const d = mkdtempSync(join(tmpdir(), "ask-real-"));
    try {
      createAskLog(d).append({ ...ask, id: "real-1" });
      const raw = readFileSync(join(d, "asks.jsonl"), "utf8");
      expect(JSON.parse(raw.trim()).id).toBe("real-1");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
