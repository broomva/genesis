import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateAdapter, botStateFile, createFileState } from "./file-state";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "gen-botstate-")), "subs.json");
}

describe("FileStateAdapter", () => {
  test("subscriptions survive a restart (the BRO-1492 bug)", async () => {
    const file = tmpFile();
    const a = createFileState(file);
    await a.connect();
    await a.subscribe("telegram:547052379");
    expect(await a.isSubscribed("telegram:547052379")).toBe(true);
    await a.disconnect();

    // Fresh instance over the same file = a process restart.
    const b = createFileState(file);
    await b.connect();
    expect(await b.isSubscribed("telegram:547052379")).toBe(true);
    expect(await b.isSubscribed("telegram:999")).toBe(false);
    await b.disconnect();
  });

  test("unsubscribe persists across a restart", async () => {
    const file = tmpFile();
    const a = createFileState(file);
    await a.connect();
    await a.subscribe("t1");
    await a.unsubscribe("t1");
    await a.disconnect();

    const b = createFileState(file);
    await b.connect();
    expect(await b.isSubscribed("t1")).toBe(false);
    await b.disconnect();
  });

  test("seed() recovers a thread before connect (immediate recovery path)", async () => {
    const file = tmpFile();
    const a = new FileStateAdapter(file);
    a.seed("telegram:547052379"); // pre-write without a running bot
    const b = createFileState(file);
    await b.connect();
    expect(await b.isSubscribed("telegram:547052379")).toBe(true);
    await b.disconnect();
  });

  test("missing / corrupt state file → starts empty, never throws", async () => {
    const a = createFileState("/nonexistent-dir/does-not-exist.json");
    await a.connect();
    expect(await a.isSubscribed("anything")).toBe(false);
    await a.disconnect();
  });

  test("ephemeral kv + locks delegate to memory (not persisted)", async () => {
    const file = tmpFile();
    const a = createFileState(file);
    await a.connect();
    await a.set("k", "v");
    expect(await a.get<string>("k")).toBe("v");
    const lock = await a.acquireLock("t", 1000);
    expect(lock).not.toBeNull();
    // ephemeral state does NOT cross a restart (correct — a dead process's lock
    // must not survive it).
    await a.disconnect();
    const b = createFileState(file);
    await b.connect();
    expect(await b.get<string>("k")).toBeNull();
    await b.disconnect();
  });

  test("botStateFile builds a stable path under the dir", () => {
    expect(botStateFile("/tmp/x")).toBe("/tmp/x/telegram-subscriptions.json");
    expect(botStateFile("/tmp/x/")).toBe("/tmp/x/telegram-subscriptions.json");
  });
});
