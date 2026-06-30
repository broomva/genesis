import { type RefObject, useEffect, useRef, useState } from "react";

// Auto-hide the bottom composer on mobile while reading message history, and
// reveal it scrolling back toward the newest message (BRO-1626). This is the
// "quick return" / hide-on-scroll / headroom pattern (Material 3 app-bars,
// Headroom.js). The decision core is a pure function so the hysteresis + the
// hard "always show" overrides are unit-testable without a DOM.

export interface AutoHideMetrics {
  /** The scroll container's current scrollTop (may be out of range mid rubber-band). */
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface AutoHideConfig {
  /** Coarse-pointer / small viewport. When false the composer always shows. */
  mobile: boolean;
  /** Composer textarea focused / soft keyboard open. */
  focused: boolean;
  /** A turn is in flight (submitted/streaming). */
  streaming: boolean;
  /** A transient signal must stay visible (e.g. a slash-command notice). */
  forceShow: boolean;
  /** Anti-jitter delta, px — movements smaller than this are ignored. */
  threshold: number;
  /** Within this many px of the newest message, always show. */
  bottomZone: number;
}

export interface AutoHideState {
  hidden: boolean;
  /** The committed scroll anchor the next delta is measured against. */
  lastY: number;
}

export const DEFAULT_THRESHOLD = 8;
export const DEFAULT_BOTTOM_ZONE = 96;

/**
 * Pure decision core for the composer auto-hide. Given the previous state, the
 * current scroll metrics and the override flags, return the next {hidden, lastY}.
 *
 * Direction: in a stick-to-bottom chat the newest message is at the BOTTOM, so
 * `scrollTop` grows toward the newest. Moving toward newest (delta > 0) reveals;
 * moving toward older (delta < 0) hides. This is the inverse of a classic top
 * header — stated explicitly so it isn't flipped.
 *
 * `scrollTop` is clamped to `[0, max]` first so iOS rubber-band overscroll
 * (negative at the top, > max at the bottom) can't produce spurious flips.
 */
export function nextAutoHideState(
  prev: AutoHideState,
  metrics: AutoHideMetrics,
  cfg: AutoHideConfig,
): AutoHideState {
  const max = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const y = Math.max(0, Math.min(metrics.scrollTop, max));

  // Hard "always show" overrides — checked first, every frame.
  if (
    !cfg.mobile ||
    max <= 0 || // content shorter than the viewport — nothing to scroll
    cfg.focused ||
    cfg.streaming ||
    cfg.forceShow ||
    max - y <= cfg.bottomZone // at/near the newest message
  ) {
    return { hidden: false, lastY: y };
  }

  const delta = y - prev.lastY;
  // Below the hysteresis threshold: hold BOTH the hidden state and the anchor, so
  // small jitters don't flip the bar and slow scrolls still accumulate to a commit.
  if (Math.abs(delta) < cfg.threshold) return prev;

  return { hidden: delta < 0, lastY: y };
}

export interface UseComposerAutoHideOptions {
  focused?: boolean;
  streaming?: boolean;
  forceShow?: boolean;
  threshold?: number;
  bottomZone?: number;
}

/**
 * Hide the bottom composer on mobile when scrolling toward older messages and
 * reveal it scrolling back toward the newest (BRO-1626). Mobile-only
 * (`pointer: coarse`); desktop always shows. A passive, rAF-throttled scroll
 * listener on `scrollRef` feeds {@link nextAutoHideState}. Returns whether the
 * composer should be hidden.
 */
export function useComposerAutoHide(
  scrollRef: RefObject<HTMLElement | null>,
  {
    focused = false,
    streaming = false,
    forceShow = false,
    threshold = DEFAULT_THRESHOLD,
    bottomZone = DEFAULT_BOTTOM_ZONE,
  }: UseComposerAutoHideOptions = {},
): boolean {
  const [hidden, setHidden] = useState(false);
  // Mirror the latest hidden + override flags into refs so the scroll handler
  // reads current values without re-subscribing (which would churn + reset lastY).
  const hiddenRef = useRef(false);
  hiddenRef.current = hidden;
  const lastYRef = useRef(0);
  const cfgRef = useRef<Omit<AutoHideConfig, "mobile">>({
    focused,
    streaming,
    forceShow,
    threshold,
    bottomZone,
  });
  cfgRef.current = { focused, streaming, forceShow, threshold, bottomZone };

  // Override flags are read via cfgRef inside the handler, so the listener only
  // re-subscribes when the scroll element ref itself changes (stable in practice).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(pointer: coarse)");
    lastYRef.current = el.scrollTop;
    let raf = 0;

    const evaluate = () => {
      raf = 0;
      const next = nextAutoHideState(
        { hidden: hiddenRef.current, lastY: lastYRef.current },
        { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
        { mobile: mq.matches, ...cfgRef.current },
      );
      lastYRef.current = next.lastY;
      if (next.hidden !== hiddenRef.current) setHidden(next.hidden);
    };

    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(evaluate);
    };
    // Re-evaluate when coarse/fine pointer changes (e.g. tablet rotation, devtools).
    const onMqChange = () => evaluate();

    // Recover from a layout change that fires no scroll (orientation, the soft
    // keyboard, browser-chrome show/hide): re-run the overrides so a resize that
    // makes the content non-scrollable / near-bottom can un-hide — otherwise the
    // composer could stay hidden + inert with no scrollable area to recover from.
    // Scheduled through the same rAF throttle as scroll (P20 BRO-1626).
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onScroll) : null;
    ro?.observe(el);

    el.addEventListener("scroll", onScroll, { passive: true });
    mq.addEventListener("change", onMqChange);
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      el.removeEventListener("scroll", onScroll);
      mq.removeEventListener("change", onMqChange);
      window.removeEventListener("resize", onScroll);
    };
  }, [scrollRef]);

  // When an override flips on between scroll frames (focus, send, notice), reveal
  // immediately rather than waiting for the next scroll.
  useEffect(() => {
    if (focused || streaming || forceShow) setHidden(false);
  }, [focused, streaming, forceShow]);

  return hidden;
}
