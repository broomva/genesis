import { describe, expect, test } from "bun:test";
import { reconcileInterruptedSessions } from "./reconcile";
import { InMemoryStore, isoNow, newId } from "./store";
import type { RunPhase } from "./types";

const WS = "ws-1";

async function seed(store: InMemoryStore, phases: RunPhase[]) {
  for (const phase of phases) {
    await store.upsertSession({
      id: newId("sess"),
      workspaceId: WS,
      threadId: `thread-${phase}-${newId("t")}`,
      phase,
      createdAt: isoNow(),
    });
  }
}

describe("reconcileInterruptedSessions", () => {
  test("resets orphaned running + awaiting sessions to blocked, leaves terminal phases alone", async () => {
    const store = new InMemoryStore();
    // Both non-terminal phases are orphaned by a crash; terminal/idle are not.
    await seed(store, ["running", "awaiting", "done", "idle", "blocked", "running"]);

    const { reconciled, threadIds } = await reconcileInterruptedSessions(store);
    expect(reconciled).toBe(3); // 2 running + 1 awaiting
    expect(threadIds).toHaveLength(3);

    // No session is left in a non-terminal phase after reconciliation.
    expect(await store.findSessionsByPhase(["running", "awaiting"])).toHaveLength(0);
    // The non-interrupted phases are untouched.
    expect(await store.findSessionsByPhase(["done"])).toHaveLength(1);
    expect(await store.findSessionsByPhase(["idle"])).toHaveLength(1);
    // 1 pre-existing blocked + 3 newly reconciled.
    expect(await store.findSessionsByPhase(["blocked"])).toHaveLength(4);
  });

  test("is idempotent — a second run finds nothing to reconcile", async () => {
    const store = new InMemoryStore();
    await seed(store, ["running"]);
    expect((await reconcileInterruptedSessions(store)).reconciled).toBe(1);
    expect((await reconcileInterruptedSessions(store)).reconciled).toBe(0);
  });

  test("no-op on an empty store", async () => {
    const { reconciled } = await reconcileInterruptedSessions(new InMemoryStore());
    expect(reconciled).toBe(0);
  });
});

describe("InMemoryStore.findSessionsByPhase", () => {
  test("filters by phase set and returns copies", async () => {
    const store = new InMemoryStore();
    await seed(store, ["running", "awaiting", "done"]);
    const got = await store.findSessionsByPhase(["running", "awaiting"]);
    expect(got).toHaveLength(2);
    expect(new Set(got.map((s) => s.phase))).toEqual(new Set(["running", "awaiting"]));
    // mutating a returned copy must not corrupt the store
    const first = got[0];
    if (!first) throw new Error("expected at least one session");
    first.phase = "done";
    expect((await store.findSessionsByPhase(["running", "awaiting"])).length).toBe(2);
  });

  test("empty phase list returns nothing", async () => {
    const store = new InMemoryStore();
    await seed(store, ["running"]);
    expect(await store.findSessionsByPhase([])).toHaveLength(0);
  });
});
