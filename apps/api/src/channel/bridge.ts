// Bridge a push/callback producer (Supervisor.dispatch's onState) into a pull
// AsyncIterable<OutgoingEvent> the connector can stream. A bounded promise queue:
// the producer emits; the consumer awaits the next item; the producer's
// completion (or throw) ends/raises on the iterable.

import type { OutgoingEvent } from "./types";

/** Run `producer(emit)`; expose everything it emits as an async iterable.
 *  The iterable ends when the producer resolves, and throws if it rejects. */
export function eventStream(
  producer: (emit: (e: OutgoingEvent) => void) => Promise<void>,
): AsyncIterable<OutgoingEvent> {
  const queue: OutgoingEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let failure: unknown;

  const emit = (e: OutgoingEvent) => {
    queue.push(e);
    wake?.();
    wake = null;
  };

  // Kick off the producer; record terminal state and wake any waiter.
  producer(emit)
    .then(() => {
      done = true;
    })
    .catch((e) => {
      failure = e;
      done = true;
    })
    .finally(() => {
      wake?.();
      wake = null;
    });

  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as OutgoingEvent;
          continue;
        }
        if (done) {
          if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
