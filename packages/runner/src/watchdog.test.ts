import { describe, expect, test } from "bun:test";
import { TurnReapedError, formatDuration, startWatchdog } from "./watchdog";

/** A controllable clock. Real timers would make these tests either slow or
 *  flaky, and a flaky timeout test gets deleted rather than fixed. */
function fakeTimers() {
  let next = 1;
  const pending = new Map<number, { fn: () => void; at: number }>();
  let now = 0;
  return {
    api: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        const id = next++;
        pending.set(id, { fn, at: now + ms });
        return id;
      },
      clearTimeout: (h: unknown): void => {
        pending.delete(h as number);
      },
    },
    /** Advance the clock, firing anything due, in time order. */
    advance(ms: number) {
      now += ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, v]) => v.at <= now)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        due[1].fn();
      }
    },
    get outstanding() {
      return pending.size;
    },
  };
}

describe("startWatchdog — idle clock", () => {
  test("fires when the stream goes quiet", () => {
    const t = fakeTimers();
    const fired: string[] = [];
    const w = startWatchdog({
      idleTimeoutMs: 1000,
      onExpire: (r) => fired.push(r),
      timers: t.api,
    });
    t.advance(1000);
    expect(fired).toEqual(["idle"]);
    expect(w.reason).toBe("idle");
  });

  // The POSITIVE half: a watchdog that always fired would pass the test above.
  test("touch() keeps a busy stream alive indefinitely", () => {
    const t = fakeTimers();
    const fired: string[] = [];
    const w = startWatchdog({
      idleTimeoutMs: 1000,
      onExpire: (r) => fired.push(r),
      timers: t.api,
    });
    for (let i = 0; i < 20; i++) {
      t.advance(900);
      w.touch();
    }
    expect(fired).toEqual([]);
    expect(w.reason).toBeUndefined();
  });
});

describe("startWatchdog — total clock", () => {
  // This is the BRO-2275 shape and the reason two clocks exist: the turn kept
  // producing output for two and a half hours. An idle-only watchdog never fires
  // on it, so a single-clock design would not have caught the actual incident.
  test("fires on a turn that is never idle but runs too long", () => {
    const t = fakeTimers();
    const fired: string[] = [];
    const w = startWatchdog({
      idleTimeoutMs: 1000,
      maxTurnMs: 5000,
      onExpire: (r) => fired.push(r),
      timers: t.api,
    });
    for (let i = 0; i < 10; i++) {
      t.advance(600);
      w.touch(); // busy the whole time — the idle clock never expires
    }
    expect(fired).toEqual(["total"]);
    expect(w.reason).toBe("total");
  });

  test("touch() does NOT extend the total clock", () => {
    const t = fakeTimers();
    const w = startWatchdog({ maxTurnMs: 1000, onExpire: () => {}, timers: t.api });
    t.advance(500);
    w.touch();
    t.advance(500);
    expect(w.reason).toBe("total");
  });
});

describe("startWatchdog — races and lifecycle", () => {
  test("onExpire fires at most once when both clocks would expire", () => {
    const t = fakeTimers();
    const fired: string[] = [];
    startWatchdog({
      idleTimeoutMs: 1000,
      maxTurnMs: 1000,
      onExpire: (r) => fired.push(r),
      timers: t.api,
    });
    t.advance(10_000);
    expect(fired.length).toBe(1);
  });

  test("dispose() disarms both clocks and leaves nothing pending", () => {
    const t = fakeTimers();
    const fired: string[] = [];
    const w = startWatchdog({
      idleTimeoutMs: 1000,
      maxTurnMs: 2000,
      onExpire: (r) => fired.push(r),
      timers: t.api,
    });
    w.dispose();
    // BEFORE advancing. `advance()` deletes each entry as it fires, so checking
    // `outstanding` afterwards cannot tell a CLEARED timer from one that fired and
    // was suppressed by the `done` flag — a mutation making dispose() a no-op
    // survived that version of this assertion.
    expect(t.outstanding).toBe(0);
    t.advance(10_000);
    expect(fired).toEqual([]);
  });

  test("firing leaves no timer behind", () => {
    const t = fakeTimers();
    startWatchdog({ idleTimeoutMs: 100, maxTurnMs: 5000, onExpire: () => {}, timers: t.api });
    t.advance(100);
    expect(t.outstanding).toBe(0);
  });

  // Unbounded is the library default, so an existing caller that passes nothing
  // keeps today's behaviour rather than silently acquiring a kill switch.
  test("no options means no clocks at all", () => {
    const t = fakeTimers();
    const fired: string[] = [];
    startWatchdog({ onExpire: (r) => fired.push(r), timers: t.api });
    t.advance(10_000_000);
    expect(fired).toEqual([]);
    expect(t.outstanding).toBe(0);
  });

  test("zero and negative bounds mean unbounded, not instant death", () => {
    const t = fakeTimers();
    const fired: string[] = [];
    startWatchdog({
      idleTimeoutMs: 0,
      maxTurnMs: -1,
      onExpire: (r) => fired.push(r),
      timers: t.api,
    });
    t.advance(10_000_000);
    expect(fired).toEqual([]);
  });

  test("touch() after expiry does not re-arm a dead watchdog", () => {
    const t = fakeTimers();
    const fired: string[] = [];
    const w = startWatchdog({
      idleTimeoutMs: 100,
      onExpire: (r) => fired.push(r),
      timers: t.api,
    });
    t.advance(100);
    w.touch();
    t.advance(10_000);
    expect(fired).toEqual(["idle"]);
    expect(t.outstanding).toBe(0);
  });
});

describe("formatDuration (BRO-2307)", () => {
  // THE MEASURED CASE. The deployed build reaped a 20s turn and told the user it
  // had "run past the 0-minute limit" — Math.round(20_000/60_000) is 0. Production
  // defaults (15 and 30 minutes) hide this completely, so a test written with
  // realistic values would never have caught it; only a deliberately short bound
  // on the real box did.
  test("a sub-minute bound is not rendered as zero minutes", () => {
    expect(formatDuration(20_000)).toBe("20 seconds");
    expect(formatDuration(1_000)).toBe("1 second");
    expect(formatDuration(59_000)).toBe("59 seconds");
    for (const ms of [1, 999, 20_000, 59_999]) {
      expect(formatDuration(ms)).not.toMatch(/\b0 /);
    }
  });

  test("whole minutes read as minutes", () => {
    expect(formatDuration(60_000)).toBe("1 minute");
    expect(formatDuration(900_000)).toBe("15 minutes");
    expect(formatDuration(1_800_000)).toBe("30 minutes");
  });

  // Rounding 90s to "2 minutes" OVERSTATES the bound the user was actually given.
  test("a partial minute is not rounded away or up", () => {
    expect(formatDuration(90_000)).toBe("1 minute 30 seconds");
    expect(formatDuration(3_630_000)).toBe("60 minutes 30 seconds");
  });

  test("degenerate input does not produce a nonsense sentence", () => {
    for (const ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatDuration(ms)).toBe("the configured");
    }
  });
});

describe("TurnReapedError", () => {
  test("names the clock and tells the user what to do", () => {
    const idle = new TurnReapedError("idle", 900_000, 900_000);
    expect(idle.reason).toBe("idle");
    expect(idle.message).toMatch(/no output for 15 minutes/);
    expect(idle.message).toMatch(/send the message again/i);
    // An idle reap says nothing about SIZE — advising a smaller task points the
    // user away from the actual cause (BRO-2307).
    expect(idle.message).not.toMatch(/smaller/i);

    const total = new TurnReapedError("total", 1_800_000, 1_800_000);
    expect(total.message).toMatch(/30 minutes limit/);
    expect(total.message).toMatch(/smaller/i);
    expect(total.name).toBe("TurnReapedError");
  });

  test("singular minute is not pluralized", () => {
    expect(new TurnReapedError("idle", 60_000, 60_000).message).toMatch(/1 minute\b/);
  });

  // The bug exactly as it appeared on the deployed box.
  test("a 20s bound does not report a 0-minute limit", () => {
    const m = new TurnReapedError("total", 20_234, 20_000).message;
    expect(m).toContain("20 seconds");
    expect(m).not.toMatch(/0-minute|0 minute/);
  });
});
