// The distribution math behind BRO-2390, kept separate from the I/O that feeds it.
//
// WHY IT IS ITS OWN MODULE. The ticket's first DoD item is "a committed script
// regenerates the numbers from the store" and its second is "the report states n".
// Both are claims about arithmetic, and arithmetic embedded in a script that needs
// a populated database to run is arithmetic nothing tests. Split, the percentiles
// are pinned against hand-computed values and the script stays thin enough to read.

/** One agent turn's server-measured duration, in milliseconds. */
export type Durations = readonly number[];

/** Linear-interpolated percentile (the R-7 / numpy default).
 *
 *  Nearest-rank was the alternative and is rejected: with the sample sizes this
 *  will realistically see, nearest-rank makes p90 and p95 collapse onto the SAME
 *  observation, which reads as "the distribution has no tail" when it means "the
 *  sample is small". Interpolation at least moves when the data moves.
 *
 *  `p` is a fraction in [0, 1]. Returns undefined for an empty sample rather than
 *  0 or NaN: an absent measurement must not arrive as a number, which is the
 *  whole reason this ticket exists.
 */
export function percentile(values: Durations, p: number): number | undefined {
  if (values.length === 0) return undefined;
  if (!(p >= 0 && p <= 1)) throw new RangeError(`percentile p must be in [0,1], got ${p}`);
  const xs = [...values].sort((a, b) => a - b);
  if (xs.length === 1) return xs[0];
  const rank = p * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loV = xs[lo] as number;
  if (lo === hi) return loV;
  const hiV = xs[hi] as number;
  return loV + (hiV - loV) * (rank - lo);
}

export interface Summary {
  n: number;
  min?: number;
  median?: number;
  p75?: number;
  p90?: number;
  p95?: number;
  max?: number;
  /** Distinct values. A field that never varies is not a measurement — if every
   *  turn reports the same duration the instrument is stuck, and a percentile
   *  over it is a constant wearing a statistic's clothes. */
  distinct: number;
}

export function summarize(values: Durations): Summary {
  const xs = [...values].sort((a, b) => a - b);
  return {
    n: xs.length,
    ...(xs.length > 0
      ? {
          min: xs[0],
          median: percentile(xs, 0.5),
          p75: percentile(xs, 0.75),
          p90: percentile(xs, 0.9),
          p95: percentile(xs, 0.95),
          max: xs[xs.length - 1],
        }
      : {}),
    distinct: new Set(xs).size,
  };
}

/** How many observations lie strictly above a percentile's value.
 *
 *  THIS IS THE HONESTY CHECK, and it is why the ticket exists. A p95 computed
 *  from 12 samples is decided by at most one observation — quote it and you have
 *  laundered an anecdote into a statistic. The deadline D must not be chosen from
 *  a percentile that no more than one turn actually sits above.
 */
export function observationsAbove(values: Durations, p: number): number {
  const v = percentile(values, p);
  if (v === undefined) return 0;
  return values.filter((x) => x > v).length;
}

/** The minimum number of observations that must sit above the chosen percentile
 *  before a value may be named. Two, not one: a single observation above the
 *  line is indistinguishable from an outlier, and D is a deadline — being wrong
 *  in the short direction cuts a real answer off. */
export const MIN_ABOVE = 2;

export interface Verdict {
  sufficient: boolean;
  reason: string;
  /** Present ONLY when sufficient. Absent is the point: an insufficient sample
   *  must not yield a number a caller can accidentally read. */
  D?: number;
  percentile?: number;
  above?: number;
}

/** Decide whether a deadline may be named from this sample, and if so, what it is. */
export function chooseD(values: Durations, p: number): Verdict {
  const s = summarize(values);
  if (s.n === 0) {
    return { sufficient: false, reason: "no turns carry a durationMs — nothing to measure" };
  }
  if (s.distinct < 2) {
    return {
      sufficient: false,
      reason: `all ${s.n} observations share one value (${s.min}ms) — a constant is not a distribution, so the instrument is suspect before the sample is`,
    };
  }
  const above = observationsAbove(values, p);
  if (above < MIN_ABOVE) {
    return {
      sufficient: false,
      above,
      reason: `p${Math.round(p * 100)} has only ${above} observation(s) above it (need ${MIN_ABOVE}); with n=${s.n} this percentile is an anecdote, not a tail`,
    };
  }
  return {
    sufficient: true,
    D: percentile(values, p),
    percentile: p,
    above,
    reason: `p${Math.round(p * 100)} over n=${s.n}, with ${above} observations above it`,
  };
}

/** What fraction of turns finish within `ms`.
 *
 *  THE INVERSION THAT MATTERS. "What is p90" is the wrong first question for a
 *  voice hold, because D is not free to be whatever the distribution says: it is
 *  bounded above by what a person will tolerate as silence on a call. Measured,
 *  p90 is 87.5s — nobody holds a line for that. So the decision-relevant question
 *  is the other direction: at a hold a human WILL tolerate, what share of turns
 *  actually land inside it, and therefore how often does the follow-up path run?
 *
 *  Returns a fraction in [0,1], or undefined for an empty sample.
 */
export function fractionUnder(values: Durations, ms: number): number | undefined {
  if (values.length === 0) return undefined;
  return values.filter((x) => x <= ms).length / values.length;
}

/** Durations too short to be a real agent completion.
 *
 *  A 26ms "agent turn" is not a model round trip; it is an error path, a refusal,
 *  or a cached reply. They are LEFT IN the distribution — silently dropping data
 *  to make a statistic prettier is the failure this ticket exists to prevent —
 *  but they are counted and reported, so a reader can see how much of the fast
 *  tail is not really work. */
export function implausiblyFast(values: Durations, floorMs = 1000): number {
  return values.filter((x) => x < floorMs).length;
}
