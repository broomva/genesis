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
    return () => set?.delete(fn);
  }

  publish(threadId: string, msg: unknown): void {
    const set = this.subs.get(threadId);
    if (!set) return;
    for (const fn of set) fn(msg);
  }
}
