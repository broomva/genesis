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

/** Prove the detector can actually observe a running process before any "0
 *  survivors" is believed (P20 round 4). Checking that `pgrep` EXISTS is not that:
 *  in one environment `pgrep -f '[b]ash'` returned status 3 (no match) while the
 *  piped survivor count still read 0, so the control passed having established
 *  nothing. Start a sentinel we know is alive and require pgrep to find it. */
function assertPgrepCanSeeProcesses(): void {
  const sentinelMark = `bro2260-sentinel-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  // A LOOP, not `sleep 5 # mark`: bash execs into a lone final command, replacing
  // its own argv, so the marker vanished and pgrep genuinely could not see it —
  // which this control correctly reported rather than passing anyway.
  const sentinel = Bun.spawn(["bash", "-c", `while true; do sleep 0.2; done # ${sentinelMark}`], {
    stdout: "ignore",
  });
  try {
    // Give it a moment to appear in the process table.
    Bun.spawnSync(["bash", "-c", "sleep 0.2"]);
    const pat = `[${sentinelMark[0]}]${sentinelMark.slice(1)}`;
    const found = Bun.spawnSync(["bash", "-c", `pgrep -f '${pat}' | wc -l | tr -d ' '`])
      .stdout.toString()
      .trim();
    if (Number(found) < 1) {
      throw new Error(
        "pgrep cannot observe a process this test just started — every survivor count below would be a false zero.",
      );
    }
  } finally {
    sentinel.kill("SIGKILL");
  }
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
    // PROVE THE APPARATUS IS LIVE before trusting a zero (P20 round 2). Piping
    // pgrep into `wc -l` discards its status, so a missing or unprivileged pgrep
    // yields "0" — indistinguishable from "no survivors". A denial is only
    // evidence when the detector could have said otherwise.
    assertPgrepCanSeeProcesses();

    const survivors = Bun.spawnSync(["bash", "-c", `pgrep -f '${pattern}' | wc -l | tr -d ' '`])
      .stdout.toString()
      .trim();
    expect(Number(survivors)).toBe(0);
  });

  // P20 round 3 blocker, and the regression it named: a COMPLIANT leader exits on
  // SIGTERM while a TERM-ignoring descendant keeps running and keeps stdout open.
  // The first exit-latch treated the leader's exit as settlement and suppressed the
  // escalation's SIGKILL, hanging the turn — and the admission slot — forever.
  test("leader exits on SIGTERM but a TERM-ignoring descendant does not hang the turn", async () => {
    const marker = `bro2260-leader-${process.pid}-${Date.now()}`;
    const h = new LocalHost().spawnStream([
      "bash",
      "-c",
      `bash -c 'trap "" TERM; while true; do echo ${marker}; sleep 0.05; done' & wait`,
    ]);
    await new Promise((r) => setTimeout(r, 300));

    // Exactly what the watchdog does: polite signal, then escalate.
    h.kill(); // leader obeys and exits; descendant ignores and holds stdout
    setTimeout(() => h.kill("SIGKILL"), 200);

    expect(await streamEndsWithin(h, 4000)).toBe(true);

    await new Promise((r) => setTimeout(r, 300));
    const pattern = `[${marker[0]}]${marker.slice(1)}`;
    assertPgrepCanSeeProcesses();
    const survivors = Bun.spawnSync(["bash", "-c", `pgrep -f '${pattern}' | wc -l | tr -d ' '`])
      .stdout.toString()
      .trim();
    expect(Number(survivors)).toBe(0);
  });

  // P20 round 4 blocker. The nastiest shape yet: a descendant that ignores SIGTERM
  // AND closes its stdout (`exec >/dev/null`). The stream then ENDS — so
  // "stdout closed" is not group settlement — the handle read as finished, the
  // delayed SIGKILL was suppressed, and the process kept running. That is the
  // incident's own shape: a build or clone that redirects its output.
  test("a descendant that closes stdout is still reaped", async () => {
    assertPgrepCanSeeProcesses();
    const h = new LocalHost().spawnStream([
      "bash",
      "-c",
      `bash -c 'trap "" TERM; echo $$; exec >/dev/null; while true; do sleep 1; done' & wait`,
    ]);
    let descendantPid = 0;
    const drain = (async () => {
      for await (const line of h.stdout) {
        if (!descendantPid) descendantPid = Number(line.trim());
      }
    })();
    await new Promise((r) => setTimeout(r, 300));
    h.kill();
    setTimeout(() => h.kill("SIGKILL"), 200);
    await drain;
    await h.exitCode;
    await new Promise((r) => setTimeout(r, 700));

    expect(descendantPid).toBeGreaterThan(0); // the probe actually ran
    let alive = false;
    try {
      process.kill(descendantPid, 0);
      alive = true;
    } catch {
      // gone, as required
    }
    if (alive) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // best effort cleanup
      }
    }
    expect(alive).toBe(false);
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
