import { describe, expect, test } from "bun:test";
import { formatClock, formatDuration } from "./duration";

describe("formatDuration (BRO-1610)", () => {
  test("sub-minute → seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(24_000)).toBe("24s");
    expect(formatDuration(59_400)).toBe("59s"); // rounds to 59
  });
  test("minutes → 'Xm YYs' with zero-padded seconds", () => {
    expect(formatDuration(84_000)).toBe("1m 24s");
    expect(formatDuration(324_000)).toBe("5m 24s"); // the reference value
    expect(formatDuration(63_000)).toBe("1m 03s"); // pad
  });
  test("hours → 'Xh YYm'", () => {
    expect(formatDuration(3_900_000)).toBe("1h 05m");
  });
  test("missing / negative / non-finite → undefined", () => {
    expect(formatDuration(undefined)).toBeUndefined();
    expect(formatDuration(null)).toBeUndefined();
    expect(formatDuration(-5)).toBeUndefined();
    expect(formatDuration(Number.NaN)).toBeUndefined();
  });
});

describe("formatClock (BRO-1610)", () => {
  test("ticking m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(24_000)).toBe("0:24");
    expect(formatClock(65_000)).toBe("1:05");
  });
  test("hours roll into h:mm:ss", () => {
    expect(formatClock(3_725_000)).toBe("1:02:05");
  });
  test("missing → 0:00 (never blank in the live counter)", () => {
    expect(formatClock(undefined)).toBe("0:00");
    expect(formatClock(-1)).toBe("0:00");
  });
});
