import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type LockRecord,
  acquireEvalLock,
  isProcessAlive,
  parseRecord,
  refusalMessage,
  releaseEvalLock,
} from "./eval-lock";

const HELD: LockRecord = {
  pid: 4242,
  startedAt: "2026-08-23T17:09:00.000Z",
  tenantDir: "/home/agent/orchestrator-workspaces/573017758620",
  nonce: "nonce-held",
};

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

describe("acquireEvalLock — one create attempt, no takeover", () => {
  test("free path: creates exclusively, exactly once", () => {
    const calls: Array<[string, string]> = [];
    const out = acquireEvalLock("/l", "/tenants/a", {
      readFile: () => null,
      createExclusive: (p, b) => {
        calls.push([p, b]);
      },
      pid: 77,
      now: () => new Date("2026-08-23T18:00:00.000Z"),
      nonce: () => "N1",
    });
    expect(out.ok).toBe(true);
    // Exactly one write rules out both "acquired without writing" and a retry loop.
    expect(calls).toHaveLength(1);
    const [, body] = calls[0] as [string, string];
    expect(JSON.parse(body)).toEqual({
      pid: 77,
      startedAt: "2026-08-23T18:00:00.000Z",
      tenantDir: "/tenants/a",
      nonce: "N1",
    });
  });

  test("EEXIST → refused, and reports the holder", () => {
    const out = acquireEvalLock("/l", "/tenants/b", {
      readFile: () => JSON.stringify(HELD),
      createExclusive: () => {
        throw EEXIST;
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.heldBy?.pid).toBe(4242);
  });

  // The v2 defect this design deletes: a dead holder must NOT be auto-reclaimed,
  // because every takeover path reintroduced concurrent runners.
  test("EEXIST with a DEAD holder is still refused — no auto-takeover", () => {
    let creates = 0;
    let removed = false;
    const out = acquireEvalLock("/l", "/tenants/c", {
      readFile: () => JSON.stringify(HELD),
      createExclusive: () => {
        creates++;
        throw EEXIST;
      },
      remove: () => {
        removed = true;
        return true;
      },
    });
    expect(out.ok).toBe(false);
    expect(creates).toBe(1); // exactly one attempt — no retry loop
    expect(removed).toBe(false); // nothing is ever unlinked during acquisition
  });

  test("EEXIST with an unreadable record → refused with heldBy null, never acquired", () => {
    const out = acquireEvalLock("/l", "/t", {
      readFile: () => "{partial",
      createExclusive: () => {
        throw EEXIST;
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.heldBy).toBeNull();
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
          return true;
        },
      }),
    ).toBe(true);
    expect(removed).toBe(true);
  });

  test("does NOT remove a lock written by someone else", () => {
    let removed = false;
    expect(
      releaseEvalLock("/l", mine, {
        readFile: () => JSON.stringify({ ...HELD, nonce: "THEIRS" }),
        remove: () => {
          removed = true;
          return true;
        },
      }),
    ).toBe(false);
    expect(removed).toBe(false);
  });

  // The return value must not overstate what happened.
  test("reports FALSE when the unlink itself fails", () => {
    expect(
      releaseEvalLock("/l", mine, { readFile: () => JSON.stringify(mine), remove: () => false }),
    ).toBe(false);
  });

  test("no lock file → nothing removed", () => {
    expect(releaseEvalLock("/l", mine, { readFile: () => null, remove: () => true })).toBe(false);
  });

  test("null record (never acquired) → nothing removed", () => {
    let removed = false;
    expect(
      releaseEvalLock("/l", null, {
        readFile: () => JSON.stringify(mine),
        remove: () => {
          removed = true;
          return true;
        },
      }),
    ).toBe(false);
    expect(removed).toBe(false);
  });
});

describe("parseRecord — reporting only, so nonsense is merely null", () => {
  test.each([
    ["absent", null],
    ["not json", "{oops"],
    ["partial write", '{"pid": 42, "star'],
    ["no pid", JSON.stringify({ nonce: "n" })],
    ["no nonce", JSON.stringify({ pid: 1 })],
    ["pid not a number", JSON.stringify({ pid: "x", nonce: "n" })],
  ])("%s → null", (_label, raw) => {
    expect(parseRecord(raw as string | null)).toBeNull();
  });

  test("a well-formed record round-trips", () => {
    expect(parseRecord(JSON.stringify(HELD))?.nonce).toBe("nonce-held");
  });
});

describe("isProcessAlive — advisory, never consulted by acquisition", () => {
  test("signalable → alive", () => expect(isProcessAlive(4242, () => undefined)).toBe(true));
  test("ESRCH → dead", () =>
    expect(
      isProcessAlive(4242, () => {
        throw ESRCH;
      }),
    ).toBe(false));
  // EPERM means the process EXISTS but is another user's.
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

// ---------------------------------------------------------------------------
// REAL PROCESSES. Mock tests prove the decision logic, not that the filesystem
// serialises anything. These spawn actual OS processes against a real path.
// ---------------------------------------------------------------------------

const HOLD_MS = 1500;
// The winner must HOLD while the others race, which is what a real eval does (it
// runs for minutes). An earlier racer exited the instant it acquired.
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

function runRacer(runner: string): Promise<string> {
  return new Promise<string>((res, rej) => {
    const p = spawn(process.execPath, [runner], { stdio: ["ignore", "pipe", "pipe"] });
    let o = "";
    p.stdout.on("data", (d) => {
      o += d;
    });
    p.on("error", rej);
    p.on("close", () => res(o.trim()));
  });
}

describe("real filesystem, real processes", () => {
  test("N concurrent processes: exactly ONE acquires", async () => {
    const dir = scratch();
    const lock = join(dir, "eval.lock");
    const runner = join(dir, "racer.ts");
    writeFileSync(runner, RACER(lock));

    const N = 8;
    const outs = await Promise.all(Array.from({ length: N }, () => runRacer(runner)));

    // Positive control: all N must have REPORTED. If they all crashed we would
    // see zero WONs, which must not read as "exclusion worked".
    expect(outs.filter((o) => o === "WON" || o === "LOST")).toHaveLength(N);
    expect(outs.filter((o) => o === "WON")).toHaveLength(1);
    expect(existsSync(lock)).toBe(true);
  }, 30_000);

  test("a SECOND wave, while the first winner still holds, is refused entirely", async () => {
    const dir = scratch();
    const lock = join(dir, "eval.lock");
    const runner = join(dir, "racer.ts");
    writeFileSync(runner, RACER(lock));

    const first = await runRacer(runner); // holds HOLD_MS then exits
    expect(first).toBe("WON");
    // The holder has now exited, leaving the lock behind — the deliberate
    // no-takeover cost. Every later runner must refuse until it is removed.
    const wave = await Promise.all(Array.from({ length: 4 }, () => runRacer(runner)));
    expect(wave).toEqual(["LOST", "LOST", "LOST", "LOST"]);

    // ...and removing it by hand restores service, which is the documented fix.
    rmSync(lock);
    expect(await runRacer(runner)).toBe("WON");
  }, 30_000);

  test("live holder is refused without clobbering the winner's record", () => {
    const dir = scratch();
    const lock = join(dir, "eval.lock");
    const first = acquireEvalLock(lock, "/tenants/a");
    expect(first.ok).toBe(true);

    const second = acquireEvalLock(lock, "/tenants/b");
    expect(second.ok).toBe(false);

    if (first.ok) {
      expect(JSON.parse(readFileSync(lock, "utf8")).nonce).toBe(first.record.nonce);
      expect(releaseEvalLock(lock, first.record)).toBe(true);
      expect(existsSync(lock)).toBe(false);
    }
  });

  test("a corrupt lock file is refused, not silently reclaimed", () => {
    const dir = scratch();
    const lock = join(dir, "eval.lock");
    writeFileSync(lock, "{not json");
    const out = acquireEvalLock(lock, "/tenants/z");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.heldBy).toBeNull();
    expect(existsSync(lock)).toBe(true); // never unlinked by acquisition
  });

  test("release tolerates the file vanishing underneath it", () => {
    const dir = scratch();
    const lock = join(dir, "eval.lock");
    const out = acquireEvalLock(lock, "/tenants/a");
    expect(out.ok).toBe(true);
    rmSync(lock);
    if (out.ok) expect(releaseEvalLock(lock, out.record)).toBe(false);
  });
});

describe("refusalMessage", () => {
  test("names pid, start time, tenant, lock path and the manual fix", () => {
    const m = refusalMessage(HELD, "/var/lock/eval.lock");
    expect(m).toContain("4242");
    expect(m).toContain("573017758620");
    expect(m).toContain("rm /var/lock/eval.lock");
  });

  test("advisory liveness is shown when supplied, in both polarities", () => {
    expect(refusalMessage(HELD, "/l", () => true)).toContain("RUNNING");
    expect(refusalMessage(HELD, "/l", () => false)).toContain("NOT running");
  });

  test("survives an unreadable holder record", () => {
    expect(refusalMessage(null, "/l")).toContain("unreadable");
  });
});
