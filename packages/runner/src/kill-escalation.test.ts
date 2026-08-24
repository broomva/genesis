import { describe, expect, test } from "bun:test";
import { LocalHost } from "@genesis/host";

// BRO-2260 regression. The watchdog's whole value is that a reaped turn actually
// ENDS: the `for await (… of handle.stdout)` loop in runAgent has to terminate,
// or the turn hangs forever AND the admission slot it holds is never released —
// which at perWorkspace=1 locks that workspace out permanently. That is strictly
// worse than having no watchdog at all.
//
// These tests use a real child process on the real host, not a mock. A mock that
// closed its stream on kill() would have "passed" while production hung.

/** Race the stream's completion against a deadline. */
async function streamEndsWithin(
  h: { stdout: AsyncIterable<string> },
  ms: number,
): Promise<boolean> {
  const drain = (async () => {
    for await (const _ of h.stdout) {
      // discard
    }
    return true;
  })();
  const deadline = new Promise<boolean>((res) => setTimeout(() => res(false), ms));
  return Promise.race([drain, deadline]);
}

describe("kill escalation (BRO-2260)", () => {
  // NEGATIVE CONTROL — the defect this fix exists for. If this ever starts
  // passing, SIGTERM became sufficient and the escalation could be revisited;
  // it failing is what makes the positive case below meaningful rather than
  // vacuous.
  test("a SIGTERM-ignoring child does NOT end on kill() alone", async () => {
    const h = new LocalHost().spawnStream([
      "bash",
      "-c",
      "trap '' TERM; while true; do echo tick; sleep 0.05; done",
    ]);
    setTimeout(() => h.kill(), 100);
    const ended = await streamEndsWithin(h, 1200);
    expect(ended).toBe(false);
    h.kill("SIGKILL"); // clean up the survivor
  });

  test("escalating to SIGKILL ends it", async () => {
    const h = new LocalHost().spawnStream([
      "bash",
      "-c",
      "trap '' TERM; while true; do echo tick; sleep 0.05; done",
    ]);
    setTimeout(() => {
      h.kill();
      setTimeout(() => h.kill("SIGKILL"), 200); // the runner's escalation
    }, 100);
    expect(await streamEndsWithin(h, 3000)).toBe(true);
  });

  // The ordinary case must not regress: a well-behaved child should still die on
  // the polite signal, so the escalation is a backstop and not the mechanism.
  test("a well-behaved child still ends on plain kill()", async () => {
    const h = new LocalHost().spawnStream([
      "bash",
      "-c",
      "while true; do echo tick; sleep 0.05; done",
    ]);
    setTimeout(() => h.kill(), 100);
    expect(await streamEndsWithin(h, 3000)).toBe(true);
  });

  // Codex P20 blocker 1, and the reason SIGKILL-on-the-direct-pid was not enough:
  // a real turn is `claude` -> `bash` -> `git clone`. MEASURED before this fix —
  // SIGKILL on the parent left the grandchild running AND the stream open, so the
  // reader waited forever and the admission slot was never returned.
  test("killing reaps DESCENDANTS, not just the direct child", async () => {
    const marker = `bro2260-desc-${process.pid}-${Date.now()}`;
    const h = new LocalHost().spawnStream([
      "bash",
      "-c",
      `bash -c 'while true; do echo ${marker}; sleep 0.05; done' & wait`,
    ]);
    // let the grandchild actually start before killing
    await new Promise((r) => setTimeout(r, 300));
    h.kill("SIGKILL");

    // The stream must end — a surviving descendant holding stdout is what hangs
    // the turn.
    expect(await streamEndsWithin(h, 3000)).toBe(true);

    // ...and the grandchild must actually be gone, not merely detached from us.
    await new Promise((r) => setTimeout(r, 300));
    // BRACKET TRICK, and the reason for it: `pgrep -f <marker>` also matches the
    // wrapping `bash -c` whose OWN command line contains the marker. That self-match
    // is invisible on macOS and counted on Linux, so the first version of this
    // assertion passed locally and failed in CI with "Expected 0, Received 1".
    // `[b]ro...` matches the survivor's cmdline but not pgrep's own literal one.
    const pattern = `[${marker[0]}]${marker.slice(1)}`;
    const survivors = Bun.spawnSync(["bash", "-c", `pgrep -f '${pattern}' | wc -l | tr -d ' '`])
      .stdout.toString()
      .trim();
    expect(Number(survivors)).toBe(0);
  });

  test("kill() defaults to SIGTERM, and the signal argument is honoured", async () => {
    const term = new LocalHost().spawnStream(["bash", "-c", "sleep 30"]);
    setTimeout(() => term.kill(), 50);
    expect(await term.exitCode).toBe(143); // 128 + SIGTERM(15)

    const killed = new LocalHost().spawnStream(["bash", "-c", "sleep 30"]);
    setTimeout(() => killed.kill("SIGKILL"), 50);
    expect(await killed.exitCode).toBe(137); // 128 + SIGKILL(9)
  });
});
