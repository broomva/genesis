// A liveness bound on a streaming dispatch (BRO-2245).
//
// WHY. On 2026-08-23 `POST /api/chat` returned 200, emitted its stream header,
// and then produced ZERO further bytes — measured at 170 s before the client gave
// up, and there was nothing to suggest it would ever stop. `genesisStream`
// accepts an AbortSignal but `handler.ts` never passed one, so nothing bounded
// that wait: the turn hung, the catch never ran, and the channel said nothing.
//
// Without this, the failure classifier added alongside it cannot see that case at
// all — a hang is not an error, and an unreached catch classifies nothing.
//
// A STALL BOUND, NOT A DEADLINE. The timer resets on every chunk, so a turn that
// is slow but PROGRESSING is never cut off however long it runs. Only complete
// silence trips it. A total-duration deadline would have to be set above the
// slowest legitimate turn — and a turn that is genuinely working is exactly the
// one you must not kill.
//
// THE WINDOW IS DELIBERATELY GENEROUS. `genesisStream` yields only text deltas,
// so a long tool call is legitimately silent, and tightening this would fail
// correct input rather than catch failures. Five minutes of TOTAL silence is far
// outside a working turn's envelope and still bounded. Configurable, because that
// number is a judgement about this deployment and not a law.

/** Thrown when a stream produces nothing for the whole window. Carries an
 *  `AbortError`-shaped `name` so the dispatch classifier maps it to `timeout`
 *  without needing to know this module exists. */
export class StreamStallError extends Error {
  readonly name = "AbortError";
  constructor(readonly stallMs: number) {
    super(`stream produced no output for ${stallMs}ms`);
  }
}

export const DEFAULT_STALL_MS = 5 * 60 * 1000;

/** Yield through `src`, failing if any single gap between chunks exceeds `ms`.
 *
 *  On stall the source's `return()` is invoked so the underlying request is torn
 *  down rather than left in flight — a hung dispatch that keeps its connection is
 *  the thing that exhausted the host in the first place. */
export async function* withStallTimeout<T>(
  src: AsyncGenerator<T>,
  ms: number = DEFAULT_STALL_MS,
  opts: {
    /** Invoked BEFORE the stall error propagates. This is where the caller aborts
     *  the underlying request.
     *
     *  Tearing down via the generator alone is not enough, and that is the whole
     *  reason this hook exists: `src.return()` on a generator suspended inside an
     *  `await` that never settles is QUEUED, not run, so the response body reader
     *  is never released and the socket stays open. A hung dispatch that keeps its
     *  connection is precisely what exhausted the host on 2026-08-23. Only
     *  aborting the fetch itself actually closes it. */
    onStall?: () => void;
    setTimeout?: (fn: () => void, ms: number) => unknown;
    clearTimeout?: (h: unknown) => void;
  } = {},
): AsyncGenerator<T> {
  const set = opts.setTimeout ?? ((fn, d) => setTimeout(fn, d));
  const clear = opts.clearTimeout ?? ((h) => clearTimeout(h as never));

  while (true) {
    let handle: unknown;
    const stalled = new Promise<never>((_, reject) => {
      handle = set(() => reject(new StreamStallError(ms)), ms);
    });

    let result: IteratorResult<T>;
    try {
      result = await Promise.race([src.next(), stalled]);
    } catch (err) {
      // Abort the underlying request FIRST — this is what actually closes the
      // socket. Guarded: a throwing onStall must not replace the stall error.
      try {
        opts.onStall?.();
      } catch {
        // Deliberately swallowed — see above.
      }
      // Then tear the generator down, but NEVER await it.
      //
      // A generator suspended on a promise that never settles cannot resume, so
      // its `return()` never settles either — awaiting it hangs forever, which is
      // precisely the failure this whole module exists to bound. Found by the
      // "stream that never yields" test hanging the runner.
      //
      // Fire-and-forget with a swallowed rejection: the stall is the error worth
      // reporting, and a cleanup failure must not mask or delay it.
      void Promise.resolve(src.return?.(undefined as never)).catch(() => undefined);
      throw err;
    } finally {
      clear(handle);
    }

    if (result.done) return;
    yield result.value;
  }
}
