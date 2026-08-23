// Feedback budget (BRO-2256, P20 round 2) — keeps the UX layer from starving
// the thing it reports on.
//
// THE PROBLEM. Kapso counts requests PER API KEY, project-wide, in a fixed
// one-minute window: 100 on the free plan, 500 on Pro. Replies, typing
// indicators and status reactions all draw on that one budget. The per-turn
// ceiling added in round 1 bounds a SINGLE turn to ~15 re-arms, which does
// nothing about concurrency: roughly 34 simultaneous turns still spend the
// whole free-plan window on saying "still working", and then the calls that get
// 429'd are the REPLIES. Feedback starving the product it reports on is
// strictly worse than no feedback.
//
// THE RULE. Feedback is DROP-FIRST. It may consume the budget only down to a
// reserve held for replies, and when it cannot it is discarded — never queued.
// Queueing would convert quota pressure into latency and deliver a "typing"
// indicator after the answer, which is worse than skipping it. A reply never
// consults this limiter at all: the product does not ask permission.

/** Fraction of the window feedback may consume. The remainder is reply-only. */
const FEEDBACK_SHARE = 0.5;

/** Kapso's free-plan ceiling. Deliberately the LOWEST plan: over-estimating the
 *  budget is the failure that drops replies, while under-estimating only drops
 *  indicators. Override per deploy when the plan is known to be higher. */
export const DEFAULT_REQUESTS_PER_MINUTE = 100;

export const WINDOW_MS = 60_000;

/** A fixed-window counter matching how Kapso actually meters (its window is
 *  fixed, not rolling — a rolling limiter here would be stricter than the
 *  service and drop feedback the budget would have allowed). */
export class FeedbackBudget {
  private windowStart = 0;
  private spent = 0;
  private readonly allowance: number;

  constructor(
    requestsPerMinute: number = DEFAULT_REQUESTS_PER_MINUTE,
    private readonly now: () => number = Date.now,
  ) {
    this.allowance = Math.max(0, Math.floor(requestsPerMinute * FEEDBACK_SHARE));
  }

  /** Claim one feedback request. False means DROP IT — never retry, never
   *  queue. Returns true only while feedback is inside its own share. */
  tryClaim(): boolean {
    const t = this.now();
    if (t - this.windowStart >= WINDOW_MS) {
      this.windowStart = t;
      this.spent = 0;
    }
    if (this.spent >= this.allowance) return false;
    this.spent++;
    return true;
  }

  /** Diagnostics only. */
  get remaining(): number {
    return Math.max(0, this.allowance - this.spent);
  }
}
