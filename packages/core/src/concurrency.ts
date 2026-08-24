// Turn admission control (BRO-2260) — bounds how many agent turns may run at
// once, per workspace and box-wide.
//
// WHY THIS IS NOT THE SAME AS THE CGROUP LIMIT. BRO-2275 put `MemoryMax=4G` and
// `CPUQuota=150%` on `genesis-api`, whose cgroup contains every tenant turn.
// That bounds what running turns may CONSUME. It does not bound how many may
// START, and the two failure modes are different:
//
//   cgroup only   N turns start, all admitted, and they contend inside one
//                 shared ceiling. Tenant A starves tenant B; a turn dies to the
//                 cgroup OOM killer mid-answer with no explanation to send back.
//   gate only     turns are counted but each may still consume the whole box.
//
// Together they compose: the gate decides who runs, the cgroup decides how much
// the runners get. Neither replaces the other, and shipping only one was the
// state that produced the incident.
//
// WHY REFUSE RATHER THAN QUEUE. An unbounded queue converts a capacity problem
// into a latency problem and hides it: the sender waits, Kapso's delivery times
// out (three retries, then the message is dropped for good — BRO-2275), and
// nobody is told anything. A refusal that names the reason is recoverable; the
// user resends. Same-thread turns are already serialized by the supervisor's
// per-thread chain, so this gate only ever sees genuinely CONCURRENT work.

/** Coerce a configured limit to a non-negative integer; anything else is 0
 *  (= unbounded), because a gate that admits NOTHING is an outage and a typo must
 *  not be able to cause one. */
function normalizeLimit(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.floor(v));
}

/** A held admission. Call `release()` exactly once, in a `finally`. */
export interface TurnSlot {
  release(): void;
}

export class TurnRejectedError extends Error {
  constructor(
    readonly scope: "workspace" | "global",
    readonly limit: number,
  ) {
    super(
      scope === "workspace"
        ? `You already have ${limit} turn${limit === 1 ? "" : "s"} running. Wait for ${limit === 1 ? "it" : "one"} to finish, then send this again.`
        : "The server is at capacity right now. Send this again in a minute.",
    );
    this.name = "TurnRejectedError";
  }
}

export interface ConcurrencyLimits {
  /** Max simultaneous turns for ONE workspace. Omit/0 → unbounded. */
  readonly perWorkspace?: number;
  /** Max simultaneous turns across every workspace. Omit/0 → unbounded. */
  readonly global?: number;
  /** Max simultaneous COSMETIC spawns (title generation) box-wide. Omit/0 →
   *  unbounded.
   *
   *  A SEPARATE budget, not a share of the turn budget (P20 round 2). Titling was
   *  first gated on the same counter as real turns, which produced a new and
   *  worse failure than the one it fixed: titling starts the instant a turn
   *  finishes, so at perWorkspace=1 it deterministically held the slot and the
   *  user's very next message was refused — by cosmetics. Real work must never
   *  queue behind decoration, and decoration must still be bounded, so it gets
   *  its own small ceiling. */
  readonly titles?: number;
}

/**
 * Counting gate over in-flight turns.
 *
 * Deliberately synchronous end-to-end: `acquire` either returns a slot or
 * throws, with no await between the check and the increment. An async gap there
 * would let two concurrent dispatches both observe `count < limit` and both be
 * admitted — the classic check-then-act race, and the one bug this whole class
 * exists to not have.
 */
export class TurnGate {
  private readonly perWorkspace: number;
  private readonly globalLimit: number;
  private readonly titleLimit: number;
  private readonly byWorkspace = new Map<string, number>();
  private inFlight = 0;
  private titlesInFlight = 0;

  constructor(limits: ConcurrencyLimits = {}) {
    // Negative or fractional configuration is a mistake, not a limit. Floor at 0
    // (= unbounded) rather than admitting nothing, because a gate that silently
    // refuses EVERY turn is an outage, and an outage caused by a typo in an env
    // var is worse than the unbounded behaviour this replaces.
    // `Number.isFinite` FIRST (Codex P20 minor): `Math.floor(NaN)` is NaN and
    // `Math.floor(Infinity)` is Infinity, and both make every `>=` comparison
    // false — i.e. silently unbounded, from a programmatic caller that thought it
    // was setting a limit. Coerce them to 0 explicitly so "unbounded" is always a
    // decision, never an accident.
    this.perWorkspace = normalizeLimit(limits.perWorkspace);
    this.globalLimit = normalizeLimit(limits.global);
    this.titleLimit = normalizeLimit(limits.titles);
  }

  /** Current in-flight count, box-wide. Exposed for logging and tests. */
  get active(): number {
    return this.inFlight;
  }

  /** Current in-flight count for one workspace. */
  activeFor(workspaceId: string): number {
    return this.byWorkspace.get(workspaceId) ?? 0;
  }

  /** In-flight cosmetic spawns. */
  get activeTitles(): number {
    return this.titlesInFlight;
  }

  /**
   * Admit a COSMETIC spawn, or return undefined.
   *
   * Returns rather than throws: a title is optional, and the caller's correct
   * response to "no" is to skip it silently. It draws on its own budget and
   * never touches the turn counters, so titling can never refuse a real turn —
   * which is precisely the regression that came from sharing one counter.
   */
  acquireTitle(): TurnSlot | undefined {
    if (this.titleLimit > 0 && this.titlesInFlight >= this.titleLimit) return undefined;
    this.titlesInFlight += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.titlesInFlight = Math.max(0, this.titlesInFlight - 1);
      },
    };
  }

  /**
   * Admit a turn or throw {@link TurnRejectedError}.
   *
   * The per-workspace check runs FIRST so a single busy tenant is told it is the
   * one at its limit, rather than being handed the generic "server is at
   * capacity" message that blames the box for the tenant's own usage.
   */
  acquire(workspaceId: string): TurnSlot {
    const mine = this.byWorkspace.get(workspaceId) ?? 0;
    if (this.perWorkspace > 0 && mine >= this.perWorkspace) {
      throw new TurnRejectedError("workspace", this.perWorkspace);
    }
    if (this.globalLimit > 0 && this.inFlight >= this.globalLimit) {
      throw new TurnRejectedError("global", this.globalLimit);
    }
    this.byWorkspace.set(workspaceId, mine + 1);
    this.inFlight += 1;
    let released = false;
    return {
      release: () => {
        // Idempotent: a double release would drive the counter negative and
        // permanently inflate capacity — a leak that only shows up as an outage
        // much later, under load, far from its cause.
        if (released) return;
        released = true;
        this.inFlight = Math.max(0, this.inFlight - 1);
        const now = (this.byWorkspace.get(workspaceId) ?? 1) - 1;
        // Delete at zero so the map does not grow one entry per workspace that
        // ever ran a turn.
        if (now <= 0) this.byWorkspace.delete(workspaceId);
        else this.byWorkspace.set(workspaceId, now);
      },
    };
  }
}
