// Minimal per-thread pub/sub for the live /ws stream (Converse L1.5 learning).
// Phase 5 replaces this with a durable bus; Phase 1 keeps it in-memory.
export type Listener = (msg: unknown) => void;

export class Hub {
  private subs = new Map<string, Set<Listener>>();

  subscribe(threadId: string, fn: Listener): () => void {
    let set = this.subs.get(threadId);
    if (!set) {
      set = new Set();
      this.subs.set(threadId, set);
    }
    set.add(fn);
    return () => {
      const s = this.subs.get(threadId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.subs.delete(threadId); // reclaim — no unbounded map growth (F17)
    };
  }

  publish(threadId: string, msg: unknown): void {
    const set = this.subs.get(threadId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(msg);
      } catch (e) {
        // One dead socket must not abort the broadcast / the run (F18).
        console.error(`[genesis] hub listener threw: ${e}`);
      }
    }
  }

  /** Number of threads with active subscribers (for tests/observability). */
  get size(): number {
    return this.subs.size;
  }
}
