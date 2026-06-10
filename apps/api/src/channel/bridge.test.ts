import { describe, expect, test } from "bun:test";
import { eventStream } from "./bridge";
import type { OutgoingEvent } from "./types";

async function drain(it: AsyncIterable<OutgoingEvent>): Promise<OutgoingEvent[]> {
  const out: OutgoingEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("eventStream — callback → async iterable bridge", () => {
  test("yields emitted events in order, then ends when the producer resolves", async () => {
    const it = eventStream(async (emit) => {
      emit({ kind: "phase", phase: "running", text: "a" });
      await new Promise((r) => setTimeout(r, 5));
      emit({ kind: "reply", phase: "done", text: "ab" });
    });
    const events = await drain(it);
    expect(events.map((e) => e.kind)).toEqual(["phase", "reply"]);
  });

  test("delivers events emitted AFTER the consumer is already waiting", async () => {
    const it = eventStream(async (emit) => {
      await new Promise((r) => setTimeout(r, 10)); // consumer parks on the wake promise first
      emit({ kind: "reply", phase: "done", text: "late" });
    });
    const events = await drain(it);
    expect(events).toEqual([{ kind: "reply", phase: "done", text: "late" }]);
  });

  test("propagates a producer rejection as a thrown error after draining buffered events", async () => {
    const it = eventStream(async (emit) => {
      emit({ kind: "phase", phase: "running", text: "partial" });
      throw new Error("dispatch blew up");
    });
    const seen: OutgoingEvent[] = [];
    await expect(
      (async () => {
        for await (const e of it) seen.push(e);
      })(),
    ).rejects.toThrow("dispatch blew up");
    expect(seen).toEqual([{ kind: "phase", phase: "running", text: "partial" }]);
  });
});
