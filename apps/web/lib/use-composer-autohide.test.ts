import { describe, expect, test } from "bun:test";
import {
  type AutoHideConfig,
  type AutoHideState,
  nextAutoHideState,
} from "./use-composer-autohide";

const CFG: AutoHideConfig = {
  mobile: true,
  focused: false,
  streaming: false,
  forceShow: false,
  threshold: 8,
  bottomZone: 96,
};

// A tall, scrollable viewport: 2000px content in a 800px window → max scroll 1200.
const TALL = { scrollHeight: 2000, clientHeight: 800 };
const shown: AutoHideState = { hidden: false, lastY: 500 };
const hiddenAt = (lastY: number): AutoHideState => ({ hidden: true, lastY });

describe("nextAutoHideState — overrides (BRO-1626)", () => {
  test("desktop (not mobile) always shows", () => {
    const r = nextAutoHideState(
      hiddenAt(500),
      { scrollTop: 100, ...TALL },
      { ...CFG, mobile: false },
    );
    expect(r.hidden).toBe(false);
  });

  test("content shorter than viewport → not scrollable → shows", () => {
    const r = nextAutoHideState(shown, { scrollTop: 0, scrollHeight: 600, clientHeight: 800 }, CFG);
    expect(r.hidden).toBe(false);
  });

  test("near the newest (within bottomZone) always shows", () => {
    // max = 1200; scrollTop 1150 → 50px from bottom ≤ 96.
    const r = nextAutoHideState(hiddenAt(1200), { scrollTop: 1150, ...TALL }, CFG);
    expect(r.hidden).toBe(false);
  });

  test("focused / streaming / forceShow each force shown", () => {
    const m = { scrollTop: 100, ...TALL };
    expect(nextAutoHideState(hiddenAt(500), m, { ...CFG, focused: true }).hidden).toBe(false);
    expect(nextAutoHideState(hiddenAt(500), m, { ...CFG, streaming: true }).hidden).toBe(false);
    expect(nextAutoHideState(hiddenAt(500), m, { ...CFG, forceShow: true }).hidden).toBe(false);
  });
});

describe("nextAutoHideState — direction + hysteresis", () => {
  test("scrolling toward older (delta < 0, up) hides", () => {
    // from anchor 500 to 400 (up by 100, toward older), away from bottom.
    const r = nextAutoHideState(shown, { scrollTop: 400, ...TALL }, CFG);
    expect(r.hidden).toBe(true);
    expect(r.lastY).toBe(400);
  });

  test("scrolling toward newest (delta > 0, down) reveals", () => {
    const r = nextAutoHideState(hiddenAt(400), { scrollTop: 520, ...TALL }, CFG);
    expect(r.hidden).toBe(false);
    expect(r.lastY).toBe(520);
  });

  test("movement below threshold holds state AND anchor (no jitter, no drift)", () => {
    const prev = hiddenAt(500);
    const r = nextAutoHideState(prev, { scrollTop: 505, ...TALL }, CFG); // 5px < 8
    expect(r).toBe(prev); // unchanged reference → same hidden + same anchor
  });

  test("slow sub-threshold scrolls accumulate against the held anchor to a commit", () => {
    // anchor stays 500 through small moves; a later 490 is −10 from 500 → commits hide.
    let s = shown;
    s = nextAutoHideState(s, { scrollTop: 497, ...TALL }, CFG); // −3, held
    s = nextAutoHideState(s, { scrollTop: 494, ...TALL }, CFG); // −6 from 500, held
    expect(s.lastY).toBe(500);
    s = nextAutoHideState(s, { scrollTop: 490, ...TALL }, CFG); // −10 from 500 → hide
    expect(s.hidden).toBe(true);
    expect(s.lastY).toBe(490);
  });
});

describe("nextAutoHideState — rubber-band clamping", () => {
  test("negative overscroll at the top clamps to 0 (no spurious flip)", () => {
    // prev anchor 0, scrollTop −40 (iOS top bounce) → clamped 0 → delta 0 < threshold.
    const r = nextAutoHideState(hiddenAt(0), { scrollTop: -40, ...TALL }, CFG);
    expect(r.lastY).toBe(0);
  });

  test("overscroll past max clamps to max and is treated as at-bottom (shows)", () => {
    const r = nextAutoHideState(hiddenAt(1200), { scrollTop: 1400, ...TALL }, CFG);
    expect(r.hidden).toBe(false); // clamped to max=1200, within bottomZone
  });
});
