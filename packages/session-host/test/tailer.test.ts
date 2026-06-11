import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptTailer } from "../src/tailer";

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("until() timed out");
    await Bun.sleep(20);
  }
}

describe("TranscriptTailer", () => {
  test("snapshot replay then live tail (daemon-restart recovery shape)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gen-tailer-"));
    const path = join(dir, "t.jsonl");
    await writeFile(path, '{"n":1}\n{"n":2}\n');

    const lines: string[] = [];
    let caughtUp = false;
    const tailer = new TranscriptTailer({
      path,
      pollMs: 30,
      onLine: (l) => lines.push(l),
      onCaughtUp: () => {
        caughtUp = true;
      },
    });
    await tailer.start();
    try {
      // Snapshot: pre-existing content replayed before caught-up.
      expect(caughtUp).toBe(true);
      expect(lines).toEqual(['{"n":1}', '{"n":2}']);
      // Live tail: appended lines arrive.
      await appendFile(path, '{"n":3}\n');
      await until(() => lines.length === 3);
      expect(lines[2]).toBe('{"n":3}');
    } finally {
      tailer.stop();
    }
  });

  test("partial writes are buffered until the newline lands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gen-tailer-"));
    const path = join(dir, "t.jsonl");
    await writeFile(path, "");
    const lines: string[] = [];
    const tailer = new TranscriptTailer({ path, pollMs: 30, onLine: (l) => lines.push(l) });
    await tailer.start();
    try {
      await appendFile(path, '{"half":');
      await Bun.sleep(120);
      expect(lines).toEqual([]); // no premature emit
      await appendFile(path, "1}\n");
      await until(() => lines.length === 1);
      expect(lines[0]).toBe('{"half":1}');
    } finally {
      tailer.stop();
    }
  });

  test("file created after start is picked up (transcript lands late)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gen-tailer-"));
    const path = join(dir, "late.jsonl");
    const lines: string[] = [];
    const tailer = new TranscriptTailer({ path, pollMs: 30, onLine: (l) => lines.push(l) });
    await tailer.start();
    try {
      await writeFile(path, '{"late":true}\n');
      await until(() => lines.length === 1);
      expect(lines[0]).toBe('{"late":true}');
    } finally {
      tailer.stop();
    }
  });
});
