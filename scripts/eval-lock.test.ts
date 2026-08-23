import { describe, expect, test } from "bun:test";
import {
  type LockRecord,
  acquireEvalLock,
  decideFromRecord,
  isProcessAlive,
  refusalMessage,
} from "./eval-lock";

const HELD: LockRecord = {
  pid: 4242,
  startedAt: "2026-08-23T17:09:00.000Z",
  tenantDir: "/home/agent/orchestrator-workspaces/573017758620",
};

const ESRCH = Object.assign(new Error("no such process"), { code: "ESRCH" });
const EPERM = Object.assign(new Error("operation not permitted"), { code: "EPERM" });

describe("isProcessAlive — the branch that decides whether a lock is stale", () => {
  test("a signalable process is alive", () => {
    expect(isProcessAlive(4242, () => undefined)).toBe(true);
  });

  test("ESRCH means dead", () => {
    expect(
      isProcessAlive(4242, () => {
        throw ESRCH;
      }),
    ).toBe(false);
  });

  // The one that matters: EPERM means the process EXISTS but is another user's.
  // Reading that as dead is how a guard hands out a lock that is still held.
  test("EPERM means ALIVE, not dead — another user's process still holds the box", () => {
    expect(
      isProcessAlive(4242, () => {
        throw EPERM;
      }),
    ).toBe(true);
  });

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

describe("decideFromRecord", () => {
  test("no lock file → acquire", () => {
    expect(decideFromRecord(null, () => true)).toEqual({ ok: true });
  });

  test("live holder → REFUSE, and reports who", () => {
    const out = decideFromRecord(JSON.stringify(HELD), () => true);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.heldBy.pid).toBe(4242);
  });

  test("dead holder → take over, recording the pid we displaced", () => {
    const out = decideFromRecord(JSON.stringify(HELD), () => false);
    expect(out).toEqual({ ok: true, tookOverStaleFrom: 4242 });
  });

  test("corrupt lock → take over rather than deadlock forever", () => {
    expect(decideFromRecord("{not json", () => true)).toEqual({ ok: true, tookOverStaleFrom: 0 });
  });

  test("lock without a numeric pid → take over", () => {
    expect(decideFromRecord(JSON.stringify({ pid: "x" }), () => true)).toEqual({
      ok: true,
      tookOverStaleFrom: 0,
    });
  });

  // Polarity control: the refusal must depend on liveness, not merely on the
  // file existing. Same bytes, opposite liveness, opposite verdict.
  test("SAME record, opposite liveness, opposite verdict", () => {
    const raw = JSON.stringify(HELD);
    expect(decideFromRecord(raw, () => true).ok).toBe(false);
    expect(decideFromRecord(raw, () => false).ok).toBe(true);
  });
});

describe("acquireEvalLock", () => {
  test("writes a record naming this pid and tenant when free", () => {
    let written: string | null = null;
    const out = acquireEvalLock("/tmp/x.lock", "/tenants/a", {
      readFile: () => null,
      writeFile: (_p, body) => {
        written = body;
      },
      pid: 77,
      now: () => "2026-08-23T18:00:00.000Z",
    });
    expect(out.ok).toBe(true);
    expect(JSON.parse(written as unknown as string)).toEqual({
      pid: 77,
      startedAt: "2026-08-23T18:00:00.000Z",
      tenantDir: "/tenants/a",
    });
  });

  test("does NOT write when refused — the holder's record must survive", () => {
    let wrote = false;
    const out = acquireEvalLock("/tmp/x.lock", "/tenants/b", {
      readFile: () => JSON.stringify(HELD),
      writeFile: () => {
        wrote = true;
      },
      kill: () => undefined, // alive
      pid: 77,
    });
    expect(out.ok).toBe(false);
    expect(wrote).toBe(false);
  });

  test("takes over a dead holder and overwrites the record", () => {
    let written = "";
    const out = acquireEvalLock("/tmp/x.lock", "/tenants/c", {
      readFile: () => JSON.stringify(HELD),
      writeFile: (_p, body) => {
        written = body;
      },
      kill: () => {
        throw ESRCH;
      },
      pid: 99,
      now: () => "2026-08-23T18:05:00.000Z",
    });
    expect(out).toEqual({ ok: true, tookOverStaleFrom: 4242 });
    expect(JSON.parse(written).pid).toBe(99);
  });

  test("EPERM holder is refused — end-to-end, not just in isProcessAlive", () => {
    const out = acquireEvalLock("/tmp/x.lock", "/tenants/d", {
      readFile: () => JSON.stringify(HELD),
      writeFile: () => {
        throw new Error("must not write");
      },
      kill: () => {
        throw EPERM;
      },
    });
    expect(out.ok).toBe(false);
  });
});

describe("refusalMessage", () => {
  test("names pid, start time, tenant and lock path so it is actionable", () => {
    const m = refusalMessage(HELD, "/var/lock/eval.lock");
    expect(m).toContain("4242");
    expect(m).toContain("2026-08-23T17:09:00.000Z");
    expect(m).toContain("573017758620");
    expect(m).toContain("/var/lock/eval.lock");
  });
});
