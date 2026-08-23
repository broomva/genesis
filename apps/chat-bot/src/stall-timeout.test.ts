import { describe, expect, test } from "bun:test";
import { classifyDispatchFailure } from "./dispatch-failure";
import { DEFAULT_STALL_MS, StreamStallError, withStallTimeout } from "./stall-timeout";

const tick = () => new Promise((r) => setTimeout(r, 0));

async function* fromDelays(
  steps: Array<{ delay: number; value?: string }>,
): AsyncGenerator<string> {
  for (const s of steps) {
    await new Promise((r) => setTimeout(r, s.delay));
    if (s.value !== undefined) yield s.value;
  }
}

async function collect<T>(g: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of g) out.push(v);
  return out;
}

describe("withStallTimeout — passes healthy streams through untouched", () => {
  test("yields every chunk, in order", async () => {
    const src = fromDelays([
      { delay: 1, value: "a" },
      { delay: 1, value: "b" },
      { delay: 1, value: "c" },
    ]);
    expect(await collect(withStallTimeout(src, 500))).toEqual(["a", "b", "c"]);
  });

  test("an empty stream completes rather than stalling", async () => {
    expect(await collect(withStallTimeout(fromDelays([]), 500))).toEqual([]);
  });

  // The overshoot this design exists to avoid: a turn that is SLOW but making
  // progress must never be cut off, however long it runs in total. Total elapsed
  // here (~240ms) far exceeds the 120ms window; no single GAP does.
  test("slow but PROGRESSING stream is never cut off, even past the window", async () => {
    const src = fromDelays([
      { delay: 80, value: "a" },
      { delay: 80, value: "b" },
      { delay: 80, value: "c" },
    ]);
    expect(await collect(withStallTimeout(src, 120))).toEqual(["a", "b", "c"]);
  });
});

describe("withStallTimeout — trips on silence", () => {
  // The incident's exact shape: the stream opens and then produces nothing.
  test("a stream that never yields throws StreamStallError", async () => {
    const never = (async function* () {
      await new Promise(() => {}); // never settles
      yield "unreachable";
    })();
    await expect(collect(withStallTimeout(never, 40))).rejects.toBeInstanceOf(StreamStallError);
  });

  test("a gap AFTER some output also trips, and keeps what arrived", async () => {
    const out: string[] = [];
    const src = fromDelays([
      { delay: 1, value: "a" },
      { delay: 10_000, value: "b" },
    ]);
    await expect(
      (async () => {
        for await (const v of withStallTimeout(src, 40)) out.push(v);
      })(),
    ).rejects.toBeInstanceOf(StreamStallError);
    expect(out).toEqual(["a"]);
  });

  // Without this the hung dispatch keeps its connection — which is what exhausted
  // the host during the incident.
  test("tears the source down on stall", async () => {
    let returned = false;
    const src = {
      next: () => new Promise<IteratorResult<string>>(() => {}),
      return: async () => {
        returned = true;
        return { done: true as const, value: undefined };
      },
    } as unknown as AsyncGenerator<string>;
    await expect(collect(withStallTimeout(src, 30))).rejects.toBeInstanceOf(StreamStallError);
    await tick();
    expect(returned).toBe(true);
  });

  test("a source whose return() throws still surfaces the STALL, not the cleanup error", async () => {
    const src = {
      next: () => new Promise<IteratorResult<string>>(() => {}),
      return: async () => {
        throw new Error("cleanup exploded");
      },
    } as unknown as AsyncGenerator<string>;
    await expect(collect(withStallTimeout(src, 30))).rejects.toBeInstanceOf(StreamStallError);
  });
});

describe("withStallTimeout — the timer is per-gap, not cumulative", () => {
  test("clears its timer after every chunk", async () => {
    const cleared: unknown[] = [];
    let id = 0;
    const handles: Array<{ h: number; fn: () => void }> = [];
    const src = fromDelays([
      { delay: 1, value: "a" },
      { delay: 1, value: "b" },
    ]);
    await collect(
      withStallTimeout(src, 1000, {
        setTimeout: (fn) => {
          const h = ++id;
          handles.push({ h, fn });
          return h;
        },
        clearTimeout: (h) => cleared.push(h),
      }),
    );
    // One timer armed per next(), and every one cleared — a leaked timer would
    // eventually fire against a finished stream.
    expect(cleared.length).toBe(handles.length);
    expect(new Set(cleared).size).toBe(handles.length);
  });
});

describe("integration with the failure classifier", () => {
  // The whole reason this module exists: the incident's second failure must reach
  // the classifier as a distinct class rather than hanging forever unclassified.
  test("a stall classifies as `timeout`, not `unknown`", () => {
    expect(classifyDispatchFailure(new StreamStallError(1000))).toBe("timeout");
  });

  test("and is therefore distinct from an api-down connect error", () => {
    const down = new TypeError("fetch failed");
    (down as { cause?: unknown }).cause = Object.assign(new Error("x"), { code: "ECONNREFUSED" });
    expect(classifyDispatchFailure(new StreamStallError(1000))).not.toBe(
      classifyDispatchFailure(down),
    );
  });

  test("the stall message names the window, for the log", () => {
    expect(new StreamStallError(170_000).message).toContain("170000");
  });

  test("the default window is far above a working turn, and bounded", () => {
    expect(DEFAULT_STALL_MS).toBeGreaterThanOrEqual(60_000);
    expect(DEFAULT_STALL_MS).toBeLessThanOrEqual(15 * 60_000);
  });
});
