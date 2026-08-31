// The arithmetic behind D (BRO-2390). These matter more than usual: the numbers
// this module produces are going into an architecture decision, and the ticket's
// own framing is that a guessed quantity is a fabricated one. A percentile
// function nothing pins is exactly as fabricated.

import { describe, expect, test } from "bun:test";
import {
  MIN_ABOVE,
  chooseD,
  fractionUnder,
  implausiblyFast,
  observationsAbove,
  percentile,
  summarize,
} from "./duration-stats";

describe("percentile", () => {
  // Hand-computed against the R-7 definition on [1..10]:
  // rank = p*(n-1) = p*9. p50 -> 4.5 -> 5 + 0.5*(6-5) = 5.5
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  test("interpolates between neighbours", () => {
    expect(percentile(ten, 0.5)).toBe(5.5);
    expect(percentile(ten, 0.25)).toBeCloseTo(3.25, 10);
    expect(percentile(ten, 0.9)).toBeCloseTo(9.1, 10);
  });

  test("p=0 and p=1 are min and max exactly", () => {
    expect(percentile(ten, 0)).toBe(1);
    expect(percentile(ten, 1)).toBe(10);
  });

  test("an unsorted input gives the same answer as a sorted one", () => {
    // The function sorts a COPY. If it sorted in place it would mutate the
    // caller's array, and summarize() calls it six times on the same data.
    const shuffled = [7, 2, 9, 4, 1, 10, 3, 8, 5, 6];
    const before = [...shuffled];
    expect(percentile(shuffled, 0.5)).toBe(5.5);
    expect(shuffled).toEqual(before);
  });

  test("an empty sample is undefined, not 0", () => {
    // 0 is a duration. Returning it for "no data" is how an absent measurement
    // becomes a number downstream, which is the failure this ticket exists to
    // prevent.
    expect(percentile([], 0.5)).toBeUndefined();
  });

  test("a single observation is itself at every percentile", () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
  });

  test("p outside [0,1] throws rather than extrapolating", () => {
    expect(() => percentile(ten, 1.5)).toThrow(RangeError);
    expect(() => percentile(ten, -0.1)).toThrow(RangeError);
  });
});

describe("summarize", () => {
  test("reports n and distinct", () => {
    const s = summarize([5, 5, 5, 9]);
    expect(s.n).toBe(4);
    expect(s.distinct).toBe(2);
    expect(s.min).toBe(5);
    expect(s.max).toBe(9);
  });

  test("an empty sample has n=0 and no statistics at all", () => {
    const s = summarize([]);
    expect(s.n).toBe(0);
    expect(s.median).toBeUndefined();
    expect(s.p95).toBeUndefined();
    expect(s.max).toBeUndefined();
  });
});

describe("fractionUnder", () => {
  test("the boundary is inclusive", () => {
    // A turn finishing at exactly the hold made it. Off by one here shifts every
    // coverage number in the report.
    expect(fractionUnder([10, 20, 30], 20)).toBeCloseTo(2 / 3, 10);
  });

  test("nothing and everything", () => {
    expect(fractionUnder([10, 20], 5)).toBe(0);
    expect(fractionUnder([10, 20], 100)).toBe(1);
  });

  test("empty is undefined, not 0 — 0 would read as 'nothing finishes in time'", () => {
    expect(fractionUnder([], 20)).toBeUndefined();
  });
});

describe("implausiblyFast", () => {
  test("counts sub-second durations without removing them", () => {
    const xs = [26, 900, 1000, 5000];
    expect(implausiblyFast(xs)).toBe(2);
    // The sample is untouched — dropping data to improve a statistic is the
    // failure mode, so this only counts.
    expect(xs).toHaveLength(4);
  });
});

describe("chooseD", () => {
  const spread = Array.from({ length: 100 }, (_, i) => (i + 1) * 1000);

  test("refuses on an empty sample and names no number", () => {
    const v = chooseD([], 0.9);
    expect(v.sufficient).toBe(false);
    // The ABSENCE is the assertion. A caller reading v.D must get undefined, not
    // a plausible-looking zero.
    expect(v.D).toBeUndefined();
  });

  test("refuses when every observation is identical", () => {
    // A constant field is not a measurement — if the instrument is stuck, a
    // percentile over it is a constant wearing a statistic's clothes.
    const v = chooseD([5000, 5000, 5000, 5000, 5000], 0.9);
    expect(v.sufficient).toBe(false);
    expect(v.reason).toContain("constant");
    expect(v.D).toBeUndefined();
  });

  test("refuses when too few observations sit above the percentile", () => {
    // n=5 at p90: rank 3.6, so at most one observation is above it. That is an
    // anecdote with a percentile's name on it.
    const v = chooseD([1, 2, 3, 4, 5], 0.9);
    expect(v.sufficient).toBe(false);
    expect(v.above).toBeLessThan(MIN_ABOVE);
    expect(v.D).toBeUndefined();
  });

  test("names D when the sample supports it", () => {
    const v = chooseD(spread, 0.9);
    expect(v.sufficient).toBe(true);
    expect(v.D).toBeCloseTo(90100, 0);
    expect(v.above).toBeGreaterThanOrEqual(MIN_ABOVE);
  });

  test("observationsAbove is strict, not inclusive", () => {
    // With >= the count includes the boundary observation itself, which inflates
    // the sufficiency check by exactly the case it is meant to catch.
    expect(observationsAbove([1, 2, 3, 4, 5], 1)).toBe(0);
  });
});
