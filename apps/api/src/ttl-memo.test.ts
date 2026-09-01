import { describe, expect, test } from "bun:test";
import { ttlMemo } from "./ttl-memo";

/** A fetcher that counts executions and can be released on demand, so a test can
 *  hold calls in flight and observe whether they SHARE one execution. */
function counting<T>(value: T) {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    calls: () => calls,
    release,
    fn: async (_key: string) => {
      calls++;
      await gate;
      return value;
    },
    immediate: async (_key: string) => {
      calls++;
      return value;
    },
  };
}

describe("ttlMemo", () => {
  test("a second call inside the window does not re-execute", async () => {
    const c = counting("x");
    const memo = ttlMemo(c.immediate, 10_000);
    expect(await memo("a")).toBe("x");
    expect(await memo("a")).toBe("x");
    expect(c.calls()).toBe(1);
  });

  test("CONCURRENT calls share ONE execution — the worst case this bounds", async () => {
    // The property a value cache would not have: ten simultaneous requests for
    // the same workspace must not spawn ten sets of subprocesses. They are held
    // in flight here deliberately, because a cache that only helps after the
    // first call RETURNS does nothing for a client looping over every id at once.
    const c = counting("x");
    const memo = ttlMemo(c.fn, 10_000);
    const inFlight = Array.from({ length: 10 }, () => memo("a"));
    expect(c.calls()).toBe(1);
    c.release();
    expect(await Promise.all(inFlight)).toEqual(Array(10).fill("x"));
    expect(c.calls()).toBe(1);
  });

  test("an IN-FLIGHT call is shared even past the TTL", async () => {
    // The window used to be stamped at START, so a call still running when it
    // expired was re-executed while pending. The memoized function here can run
    // longer than the window (three subprocesses, 20s each, against a 10s TTL),
    // so this was the normal case under a slow network, not an edge one.
    const c = counting("x");
    let t = 0;
    const memo = ttlMemo(c.fn, 1_000, () => t);
    const first = memo("a");
    t = 5_000; // long past the window, and the first call has NOT resolved
    const second = memo("a");
    expect(c.calls()).toBe(1);
    c.release();
    expect(await Promise.all([first, second])).toEqual(["x", "x"]);
    expect(c.calls()).toBe(1);
  });

  test("distinct keys do not share", async () => {
    const c = counting("x");
    const memo = ttlMemo(c.immediate, 10_000);
    await memo("a");
    await memo("b");
    expect(c.calls()).toBe(2);
  });

  test("the window EXPIRES — it is a cache, not a memo for the process lifetime", async () => {
    // Injected clock, so this asserts the expiry rather than sleeping past it.
    const c = counting("x");
    let t = 0;
    const memo = ttlMemo(c.immediate, 1_000, () => t);
    await memo("a");
    t = 999;
    await memo("a");
    expect(c.calls()).toBe(1);
    t = 1_000;
    await memo("a");
    expect(c.calls()).toBe(2);
  });

  test("a REJECTION is not cached — a transient error must not become sticky", async () => {
    let calls = 0;
    const memo = ttlMemo(async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
      return "ok";
    }, 10_000);
    await expect(memo("a")).rejects.toThrow("transient");
    expect(await memo("a")).toBe("ok");
    expect(calls).toBe(2);
  });
});
