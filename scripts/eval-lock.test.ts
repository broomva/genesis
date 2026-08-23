import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_MAX_AGE_MS,
  type LockRecord,
  acquireEvalLock,
  isProcessAlive,
  refusalMessage,
  releaseEvalLock,
  shouldYieldTo,
} from "./eval-lock";

const HELD: LockRecord = {
  pid: 4242,
  startedAt: "2026-08-23T17:09:00.000Z",
  tenantDir: "/home/agent/orchestrator-workspaces/573017758620",
  nonce: "nonce-held",
};
const NOW = Date.parse("2026-08-23T17:10:00.000Z");

const ESRCH = Object.assign(new Error("no such process"), { code: "ESRCH" });
const EPERM = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
const EEXIST = Object.assign(new Error("file exists"), { code: "EEXIST" });

const tmps: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "evallock-"));
  tmps.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

const LOCK_MODULE = resolve(import.meta.dir, "eval-lock.ts");

describe("isProcessAlive", () => {
  test("signalable → alive", () => expect(isProcessAlive(4242, () => undefined)).toBe(true));
  test("ESRCH → dead", () =>
    expect(
      isProcessAlive(4242, () => {
        throw ESRCH;
      }),
    ).toBe(false));
  // EPERM means the process EXISTS but is another user's. Reading it as dead is
  // how a guard hands out a lock that is still held.
  test("EPERM → ALIVE, not dead", () =>
    expect(
      isProcessAlive(4242, () => {
        throw EPERM;
      }),
    ).toBe(true));
  test.each([0, -1, 1.5, Number.NaN])("rejects non-pid %p without signalling", (bad) => {
    let signalled = false;
    expect(
      isProcessAlive(bad as number, () => {
        signalled = true;
      }),
    ).toBe(false);
    expect(signalled).toBe(false);
  });
});

describe("shouldYieldTo", () => {
  test("no record → do not yield", () => expect(shouldYieldTo(null, () => true, NOW)).toBe(false));
  test("live and fresh → yield", () => expect(shouldYieldTo(HELD, () => true, NOW)).toBe(true));
  test("dead → do not yield", () => expect(shouldYieldTo(HELD, () => false, NOW)).toBe(false));

  // Polarity control: same record, opposite liveness, opposite answer.
  test("SAME record, opposite liveness, opposite answer", () => {
    expect(shouldYieldTo(HELD, () => true, NOW)).toBe(true);
    expect(shouldYieldTo(HELD, () => false, NOW)).toBe(false);
  });

  // PID-reuse mitigation: a live pid that is too old is an unrelated process.
  test("live but older than maxAge → do not yield (pid-reuse mitigation)", () => {
    const old = NOW + DEFAULT_MAX_AGE_MS + 1;
    expect(shouldYieldTo(HELD, () => true, old)).toBe(false);
  });
  test("live and exactly at maxAge → do not yield (boundary)", () => {
    expect(shouldYieldTo(HELD, () => true, Date.parse(HELD.startedAt) + DEFAULT_MAX_AGE_MS)).toBe(
      false,
    );
  });
  // A broken timestamp must not expire a LIVE holder — fail toward yielding.
  test("unparseable startedAt on a live holder → still yield", () => {
    expect(shouldYieldTo({ ...HELD, startedAt: "not-a-date" }, () => true, NOW)).toBe(true);
  });
});

describe("acquireEvalLock — exclusivity is the create, not the read", () => {
  test("creates exclusively and returns the record", () => {
    const calls: Array<[string, string]> = [];
    const out = acquireEvalLock("/l", "/tenants/a", {
      readFile: () => null,
      createExclusive: (p, b) => calls.push([p, b]),
      pid: 77,
      now: () => new Date("2026-08-23T18:00:00.000Z"),
      nonce: () => "N1",
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.record.nonce).toBe("N1");
    // Asserting the call happened exactly once is the point, not a workaround:
    // it rules out "acquired without writing anything" as well as a retry loop.
    expect(calls).toHaveLength(1);
    const [, body] = calls[0] as [string, string];
    expect(JSON.parse(body)).toEqual({
      pid: 77,
      startedAt: "2026-08-23T18:00:00.000Z",
      tenantDir: "/tenants/a",
      nonce: "N1",
    });
  });

  test("EEXIST + live holder → refused, and nothing is removed", () => {
    let removed = false;
    const out = acquireEvalLock("/l", "/tenants/b", {
      readFile: () => JSON.stringify(HELD),
      createExclusive: () => {
        throw EEXIST;
      },
      remove: () => {
        removed = true;
      },
      kill: () => undefined,
      now: () => new Date(NOW),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.heldBy?.pid).toBe(4242);
    expect(removed).toBe(false);
  });

  test("EEXIST + dead holder → removes the stale file and retries the create", () => {
    let removed = 0;
    let creates = 0;
    const out = acquireEvalLock("/l", "/tenants/c", {
      readFile: () => JSON.stringify(HELD),
      createExclusive: () => {
        creates++;
        if (creates === 1) throw EEXIST;
      },
      remove: () => {
        removed++;
      },
      kill: () => {
        throw ESRCH;
      },
      pid: 99,
      now: () => new Date(NOW),
      nonce: () => "N2",
    });
    expect(out).toMatchObject({ ok: true, tookOverStaleFrom: 4242 });
    expect(removed).toBe(1);
    expect(creates).toBe(2);
  });

  test("always EEXIST with a live holder → refused after bounded retries, never hangs", () => {
    let creates = 0;
    const out = acquireEvalLock("/l", "/tenants/d", {
      readFile: () => JSON.stringify(HELD),
      createExclusive: () => {
        creates++;
        throw EEXIST;
      },
      kill: () => undefined,
      now: () => new Date(NOW),
    });
    expect(out.ok).toBe(false);
    expect(creates).toBeLessThanOrEqual(3);
  });

  test("a non-EEXIST error propagates rather than being read as acquired", () => {
    expect(() =>
      acquireEvalLock("/l", "/t", {
        readFile: () => null,
        createExclusive: () => {
          throw Object.assign(new Error("no space"), { code: "ENOSPC" });
        },
      }),
    ).toThrow("no space");
  });
});

describe("releaseEvalLock — ownership-checked", () => {
  const mine: LockRecord = { ...HELD, nonce: "MINE" };

  test("removes the lock when the nonce matches", () => {
    let removed = false;
    expect(
      releaseEvalLock("/l", mine, {
        readFile: () => JSON.stringify(mine),
        remove: () => {
          removed = true;
        },
      }),
    ).toBe(true);
    expect(removed).toBe(true);
  });

  // The defect this exists for: a runner must never delete a lock another
  // runner wrote after taking over, which would reopen the gate mid-run.
  test("does NOT remove a lock written by someone else", () => {
    let removed = false;
    expect(
      releaseEvalLock("/l", mine, {
        readFile: () => JSON.stringify({ ...HELD, nonce: "THEIRS" }),
        remove: () => {
          removed = true;
        },
      }),
    ).toBe(false);
    expect(removed).toBe(false);
  });

  test("no lock file → nothing removed", () => {
    expect(releaseEvalLock("/l", mine, { readFile: () => null, remove: () => {} })).toBe(false);
  });
  test("null record (never acquired) → nothing removed", () => {
    let removed = false;
    expect(
      releaseEvalLock("/l", null, {
        readFile: () => JSON.stringify(mine),
        remove: () => {
          removed = true;
        },
      }),
    ).toBe(false);
    expect(removed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// REAL PROCESSES. The mock tests above cannot establish mutual exclusion: they
// prove the decision logic, not that the filesystem serialises anything. These
// spawn actual OS processes against a real path.
// ---------------------------------------------------------------------------

// The winner must HOLD the lock while the others race, which is what a real eval
// does (it runs for minutes). An earlier version of this racer exited the instant
// it acquired, so its pid was genuinely dead by the time the next racer looked;
// the takeover path then fired correctly and 5 of 8 "won". That was the lock
// behaving as designed on a scenario that does not occur — not exclusion failing.
const HOLD_MS = 1500;
const RACER = (lock: string) => `
import { acquireEvalLock } from ${JSON.stringify(LOCK_MODULE)};
const out = acquireEvalLock(${JSON.stringify(lock)}, "/tenants/race");
if (out.ok) {
  console.log("WON");
  await new Promise((r) => setTimeout(r, ${HOLD_MS}));
} else {
  console.log("LOST");
}
`;

describe("real filesystem, real processes", () => {
  test("N concurrent processes: exactly ONE acquires", async () => {
    const dir = scratch();
    const lock = join(dir, "eval.lock");
    const runner = join(dir, "racer.ts");
    writeFileSync(runner, RACER(lock));

    const N = 8;
    const outs = await Promise.all(
      Array.from(
        { length: N },
        () =>
          new Promise<string>((res, rej) => {
            const p = spawn(process.execPath, [runner], { stdio: ["ignore", "pipe", "pipe"] });
            let o = "";
            p.stdout.on("data", (d) => {
              o += d;
            });
            p.on("error", rej);
            p.on("close", () => res(o.trim()));
          }),
      ),
    );

    const won = outs.filter((o) => o === "WON").length;
    // Positive control: if every process errored we would see 0 WON and 0
    // LOST, which must not read as "exclusion worked".
    expect(outs.filter((o) => o === "WON" || o === "LOST")).toHaveLength(N);
    expect(won).toBe(1);
    expect(existsSync(lock)).toBe(true);
  }, 30_000);

  test("a SIGKILLed holder's lock is taken over by the next runner", async () => {
    const dir = scratch();
    const lock = join(dir, "eval.lock");

    // A pid that is real, then definitively gone.
    const victim = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"]);
    const deadPid = victim.pid as number;
    writeFileSync(
      lock,
      JSON.stringify({
        pid: deadPid,
        startedAt: new Date().toISOString(),
        tenantDir: "/tenants/x",
        nonce: "DEAD",
      }),
    );
    // AWAITING 'exit' is load-bearing, not tidiness. A SIGKILLed child stays a
    // ZOMBIE until its parent reaps it, and a zombie's pid still answers
    // kill(pid, 0) — so it reads as ALIVE and the takeover never fires. An
    // earlier version polled `kill -0` in a shell instead and simply timed out.
    const exited = new Promise<void>((r) => victim.on("exit", () => r()));
    spawnSync("kill", ["-9", String(deadPid)]);
    await exited;

    const out = acquireEvalLock(lock, "/tenants/y");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.tookOverStaleFrom).toBe(deadPid);
      expect(JSON.parse(readFileSync(lock, "utf8")).nonce).toBe(out.record.nonce);
      expect(releaseEvalLock(lock, out.record)).toBe(true);
      expect(existsSync(lock)).toBe(false);
    }
  });

  test("a live holder on the real filesystem is refused", () => {
    const dir = scratch();
    const lock = join(dir, "eval.lock");
    const first = acquireEvalLock(lock, "/tenants/a");
    expect(first.ok).toBe(true);

    const second = acquireEvalLock(lock, "/tenants/b");
    expect(second.ok).toBe(false);

    // ...and the loser must not have clobbered the winner's record.
    if (first.ok) {
      expect(JSON.parse(readFileSync(lock, "utf8")).nonce).toBe(first.record.nonce);
      expect(releaseEvalLock(lock, first.record)).toBe(true);
    }
  });

  test("corrupt lock file is taken over rather than deadlocking forever", () => {
    const dir = scratch();
    const lock = join(dir, "eval.lock");
    writeFileSync(lock, "{not json");
    const out = acquireEvalLock(lock, "/tenants/z");
    expect(out.ok).toBe(true);
  });
});

describe("refusalMessage", () => {
  test("names pid, start time, tenant and lock path", () => {
    const m = refusalMessage(HELD, "/var/lock/eval.lock");
    expect(m).toContain("4242");
    expect(m).toContain("573017758620");
    expect(m).toContain("/var/lock/eval.lock");
  });
  test("survives an unreadable holder record", () => {
    expect(refusalMessage(null, "/var/lock/eval.lock")).toContain("unreadable");
  });
});
