import { describe, expect, test } from "bun:test";
import { LocalHost } from "./index";

// Real-spawn tests for LocalHost's stdin plumbing (BRO-1642). `cat` echoes its
// stdin to stdout, so a round-trip proves `input` is written + stdin is closed
// (cat only exits on EOF — a hang here would mean stdin was never ended).
describe("LocalHost.spawnStream — stdin input (BRO-1642)", () => {
  test("writes `input` to the child's stdin and closes it (EOF)", async () => {
    const host = new LocalHost();
    const handle = host.spawnStream(["cat"], { input: "line one\nline two" });
    const lines: string[] = [];
    for await (const l of handle.stdout) lines.push(l);
    expect(await handle.exitCode).toBe(0); // cat exits 0 only after stdin EOF
    expect(lines).toEqual(["line one", "line two"]);
  });

  test("handles a payload larger than the OS single-arg cap (the whole point)", async () => {
    const host = new LocalHost();
    // > 128 KiB (Linux MAX_ARG_STRLEN) — this would E2BIG as an argv element, but
    // rides stdin fine.
    const big = "x".repeat(200_000);
    const handle = host.spawnStream(["cat"], { input: big });
    let out = "";
    for await (const l of handle.stdout) out += l;
    expect(await handle.exitCode).toBe(0);
    expect(out.length).toBe(big.length);
  });

  test("no `input` → stdin is not piped (child still runs)", async () => {
    const host = new LocalHost();
    const handle = host.spawnStream(["printf", "hi\\n"]);
    const lines: string[] = [];
    for await (const l of handle.stdout) lines.push(l);
    expect(await handle.exitCode).toBe(0);
    expect(lines).toEqual(["hi"]);
  });
});
