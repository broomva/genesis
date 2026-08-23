import { describe, expect, test } from "bun:test";
import { DEFAULT_REQUESTS_PER_MINUTE, FeedbackBudget, WINDOW_MS } from "./feedback-budget";

/** Injectable clock — a real-time test of a one-minute window would take a
 *  minute, and a flaky one at that. */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

describe("FeedbackBudget — feedback must never starve replies", () => {
  test("reserves headroom: feedback cannot consume the whole window", () => {
    // The property that matters. If feedback could claim all 100, a burst of
    // concurrent turns would 429 the REPLIES — the failure this exists to stop.
    const c = clock();
    const b = new FeedbackBudget(DEFAULT_REQUESTS_PER_MINUTE, c.now);
    let granted = 0;
    for (let i = 0; i < DEFAULT_REQUESTS_PER_MINUTE * 2; i++) if (b.tryClaim()) granted++;
    expect(granted).toBeLessThan(DEFAULT_REQUESTS_PER_MINUTE);
    expect(granted).toBeGreaterThan(0); // and it is not simply off
  });

  test("models the CONCURRENCY case, not just one turn", () => {
    // Round 1 capped a single turn at ~15 re-arms; the reviewer correctly
    // rejected that as insufficient, since ~34 simultaneous turns still spend
    // the whole window. Here 40 turns share one budget and are cut off.
    const c = clock();
    const b = new FeedbackBudget(100, c.now);
    let granted = 0;
    for (let turn = 0; turn < 40; turn++) {
      for (let rearm = 0; rearm < 3; rearm++) if (b.tryClaim()) granted++;
    }
    expect(granted).toBe(50); // 50% share of 100, and not one more
  });

  test("refills on the next fixed window", () => {
    const c = clock();
    const b = new FeedbackBudget(100, c.now);
    while (b.tryClaim()) {
      /* exhaust */
    }
    expect(b.tryClaim()).toBe(false);
    c.advance(WINDOW_MS);
    expect(b.tryClaim()).toBe(true);
  });

  test("does not refill early — a fixed window is not a sliding one", () => {
    const c = clock();
    const b = new FeedbackBudget(100, c.now);
    while (b.tryClaim()) {
      /* exhaust */
    }
    c.advance(WINDOW_MS - 1);
    expect(b.tryClaim()).toBe(false);
  });

  test("a zero budget denies everything rather than dividing by chance", () => {
    const c = clock();
    expect(new FeedbackBudget(0, c.now).tryClaim()).toBe(false);
  });
});
