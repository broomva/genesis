// Turn watchdog (BRO-2260) — bounds how long a single agent turn may run.
//
// WHY TWO CLOCKS, NOT ONE. A turn can fail to finish in two different ways and
// a single timer cannot tell them apart:
//
//   idle    the stream has gone quiet — no NDJSON event for `idleTimeoutMs`.
//           Catches a wedged child that is neither producing output nor exiting.
//   total   the turn is still emitting but has run past `maxTurnMs`.
//           Catches the BRO-2275 shape: a tenant cloned a 197 MB repo and asked
//           the agent to run it; CPU sat at 100% for two and a half hours while
//           the turn kept making "progress". An idle timer alone would NEVER
//           have fired on that, because it was never idle.
//
// The converse matters just as much: a total-only timer would kill a legitimate
// long turn, and an idle-only timer would let a runaway run forever. Both
// clocks, or neither failure is covered.
//
// DEFAULTS ARE OFF. `undefined` means "no bound", so every existing caller keeps
// its current behaviour and only a caller that opts in gets reaped. A watchdog
// that silently started killing turns on upgrade would be a worse incident than
// the one it prevents.

/** Why a turn was reaped. Surfaced to the user, so it names the clock. */
export type ReapReason = "idle" | "total";

export interface WatchdogOptions {
  /** Kill after this long with no stream event. Omit/0 → no idle bound. */
  readonly idleTimeoutMs?: number;
  /** Kill after this long in total, progress or not. Omit/0 → no total bound. */
  readonly maxTurnMs?: number;
  /** Invoked once, when the first clock expires. */
  readonly onExpire: (reason: ReapReason) => void;
  /** Injected in tests. Defaults to the real timer functions. */
  readonly timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (h: unknown) => void;
  };
}

export interface Watchdog {
  /** Call on every stream event — resets the idle clock (never the total one). */
  touch(): void;
  /** Stop both clocks. Idempotent; safe in a `finally`. */
  dispose(): void;
  /** The reason this turn was reaped, or undefined if it was not. */
  readonly reason: ReapReason | undefined;
}

/**
 * Start a watchdog. `onExpire` fires AT MOST ONCE — the two clocks race, and
 * whichever wins disarms the other. Without that guard a turn that went idle and
 * then hit its total bound would be killed twice, and the second kill would
 * report the wrong reason for an already-dead child.
 */
export function startWatchdog(opts: WatchdogOptions): Watchdog {
  // Wrapped rather than passed by reference: the injectable shape uses an opaque
  // `unknown` handle so a test can hand back any token, and the platform's
  // clearTimeout does not accept `unknown`. The cast lives here, once.
  const t = opts.timers ?? {
    setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    clearTimeout: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  let idleHandle: unknown;
  let totalHandle: unknown;
  let reason: ReapReason | undefined;
  let done = false;

  const fire = (r: ReapReason) => {
    if (done) return;
    done = true;
    reason = r;
    // Disarm BEFORE the callback: the callback kills the child, which closes the
    // stream, which can re-enter through dispose() in a finally.
    if (idleHandle !== undefined) t.clearTimeout(idleHandle);
    if (totalHandle !== undefined) t.clearTimeout(totalHandle);
    idleHandle = undefined;
    totalHandle = undefined;
    opts.onExpire(r);
  };

  const armIdle = () => {
    if (done || !opts.idleTimeoutMs || opts.idleTimeoutMs <= 0) return;
    if (idleHandle !== undefined) t.clearTimeout(idleHandle);
    idleHandle = t.setTimeout(() => fire("idle"), opts.idleTimeoutMs);
  };

  if (opts.maxTurnMs && opts.maxTurnMs > 0) {
    totalHandle = t.setTimeout(() => fire("total"), opts.maxTurnMs);
  }
  armIdle();

  return {
    touch: armIdle,
    dispose() {
      done = true;
      if (idleHandle !== undefined) t.clearTimeout(idleHandle);
      if (totalHandle !== undefined) t.clearTimeout(totalHandle);
      idleHandle = undefined;
      totalHandle = undefined;
    },
    get reason() {
      return reason;
    },
  };
}

/** Thrown when a turn is killed by the watchdog. A distinct type so the
 *  supervisor can report "your turn was stopped because …" rather than the
 *  generic non-zero-exit message, which would read as a crash. */
export class TurnReapedError extends Error {
  constructor(
    readonly reason: ReapReason,
    readonly elapsedMs: number,
    readonly limitMs: number,
  ) {
    const mins = Math.round(limitMs / 60_000);
    super(
      reason === "idle"
        ? `This turn was stopped: the agent produced no output for ${mins} minute${mins === 1 ? "" : "s"}. Send the message again, or break the task into smaller steps.`
        : `This turn was stopped: it ran past the ${mins}-minute limit for a single turn. Break the task into smaller steps.`,
    );
    this.name = "TurnReapedError";
  }
}
