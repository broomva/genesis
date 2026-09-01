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
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string) => {
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = fetcher(key);
    entries.set(key, { at: now(), value });
    value.catch(() => {
      // Only evict OUR entry: a later call may already have replaced it, and
      // deleting that one would discard a live result.
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    return value;
  };
}
