/** Memoize an async lookup per key, for a short window, sharing IN-FLIGHT work.
 *
 * Extracted so both of its properties can be proven. Inline in the route they
 * were not observable: the thing being cached spawns subprocesses, and from an
 * HTTP response you cannot tell one execution from three.
 *
 * The PROMISE is cached, not the value, and that is the load-bearing part. It
 * gives in-flight de-duplication for free — N concurrent callers for the same
 * key await one execution rather than starting N — which is what bounds the
 * worst case. A value cache would only bound the steady state, and the worst
 * case here is a client looping over every workspace id at once.
 *
 * A REJECTION is evicted rather than cached. Caching a failure would turn a
 * transient error into a sticky one for the whole window, which is worse than
 * the cost the cache exists to avoid.
 */
export function ttlMemo<T>(
  fetcher: (key: string) => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): (key: string) => Promise<T> {
  // `at` is null WHILE IN FLIGHT and stamped when the promise settles, which
  // separates two questions the first version conflated:
  //
  //   "is someone already doing this?"  -> always share, regardless of age
  //   "is the RESULT still fresh?"      -> the TTL
  //
  // Stamping at START made the window expire mid-execution. The memoized call
  // here spawns up to three subprocesses each bounded at 20s, so one execution
  // can legitimately run longer than a 10s TTL — and a caller arriving after it
  // started a SECOND full execution while the first was still pending. Under a
  // stalled network that is several concurrent executions per key: exactly the
  // pile-up the cache exists to prevent, produced by the cache.
  const entries = new Map<string, { at: number | null; value: Promise<T> }>();
  return (key: string) => {
    const hit = entries.get(key);
    if (hit && (hit.at === null || now() - hit.at < ttlMs)) return hit.value;
    const value = fetcher(key);
    const entry: { at: number | null; value: Promise<T> } = { at: null, value };
    entries.set(key, entry);
    value.then(
      () => {
        entry.at = now();
      },
      () => {},
    );
    value.catch(() => {
      // Only evict OUR entry, defensively. A review flagged this guard as
      // unproven, and the honest answer is that it is now UNREACHABLE rather
      // than untested: sharing in-flight promises means no second entry can be
      // created for a key while its promise is pending, so a rejection can never
      // arrive to find itself replaced. It is kept because it costs one
      // comparison and stops that from silently becoming false if the in-flight
      // sharing above is ever narrowed — but there is deliberately no test for
      // it, because a test for an unreachable defect asserts nothing.
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    return value;
  };
}
