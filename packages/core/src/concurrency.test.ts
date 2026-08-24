import { describe, expect, test } from "bun:test";
import { TurnGate, TurnRejectedError } from "./concurrency";

describe("TurnGate — per-workspace bound", () => {
  test("admits up to the limit, then refuses", () => {
    const g = new TurnGate({ perWorkspace: 2 });
    const a = g.acquire("ws-1");
    const b = g.acquire("ws-1");
    expect(g.activeFor("ws-1")).toBe(2);
    expect(() => g.acquire("ws-1")).toThrow(TurnRejectedError);
    a.release();
    b.release();
  });

  // The POSITIVE half. A gate that refused everything would pass the test above,
  // so the recovery path has to be asserted or "bounded" is indistinguishable
  // from "broken".
  test("releasing frees the slot again", () => {
    const g = new TurnGate({ perWorkspace: 1 });
    const a = g.acquire("ws-1");
    expect(() => g.acquire("ws-1")).toThrow(TurnRejectedError);
    a.release();
    expect(() => g.acquire("ws-1")).not.toThrow();
  });

  // The whole point of a PER-workspace bound: one busy tenant must not consume
  // another tenant's capacity.
  test("one workspace at its limit does not block a different workspace", () => {
    const g = new TurnGate({ perWorkspace: 1 });
    g.acquire("ws-a");
    expect(() => g.acquire("ws-a")).toThrow(TurnRejectedError);
    expect(() => g.acquire("ws-b")).not.toThrow();
  });

  test("the refusal names the workspace scope, not the box", () => {
    const g = new TurnGate({ perWorkspace: 1 });
    g.acquire("ws-1");
    try {
      g.acquire("ws-1");
      throw new Error("expected a rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(TurnRejectedError);
      expect((e as TurnRejectedError).scope).toBe("workspace");
      // Actionable: it must tell the sender what to do, not just that it failed.
      expect((e as TurnRejectedError).message).toMatch(/wait for it to finish/i);
    }
  });
});

describe("TurnGate — global bound", () => {
  test("refuses across workspaces once the box limit is reached", () => {
    const g = new TurnGate({ global: 2 });
    g.acquire("ws-a");
    g.acquire("ws-b");
    expect(() => g.acquire("ws-c")).toThrow(TurnRejectedError);
  });

  test("the global refusal is scoped global and blames the server, not the user", () => {
    const g = new TurnGate({ global: 1 });
    g.acquire("ws-a");
    try {
      g.acquire("ws-b");
      throw new Error("expected a rejection");
    } catch (e) {
      expect((e as TurnRejectedError).scope).toBe("global");
      expect((e as TurnRejectedError).message).toMatch(/capacity/i);
    }
  });

  // Ordering matters for the message the sender reads: a tenant at its own limit
  // should be told THAT, not handed "the server is busy" — which would send them
  // to the operator for a problem they can fix by waiting.
  test("per-workspace is evaluated before global", () => {
    const g = new TurnGate({ perWorkspace: 1, global: 1 });
    g.acquire("ws-a");
    try {
      g.acquire("ws-a");
      throw new Error("expected a rejection");
    } catch (e) {
      expect((e as TurnRejectedError).scope).toBe("workspace");
    }
  });
});

describe("TurnGate — degenerate configuration", () => {
  // A gate that admits nothing is an outage. A typo in an env var must not be
  // able to cause one, so out-of-range values mean "unbounded", never "zero".
  test("omitted, zero and negative limits all mean unbounded", () => {
    for (const limits of [{}, { perWorkspace: 0 }, { perWorkspace: -5 }, { global: -1 }]) {
      const g = new TurnGate(limits);
      for (let i = 0; i < 50; i++) g.acquire("ws-1");
      expect(g.active).toBe(50);
    }
  });

  // Codex P20 minor: Math.floor(NaN) is NaN and Math.floor(Infinity) is Infinity;
  // both make every comparison false, so a programmatic caller that thought it set
  // a limit silently got none.
  test("NaN and Infinity are treated as unbounded deliberately, not accidentally", () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const g = new TurnGate({ perWorkspace: v, global: v });
      for (let i = 0; i < 10; i++) g.acquire("ws-1");
      expect(g.active).toBe(10);
    }
  });

  test("a fractional limit floors rather than admitting forever", () => {
    const g = new TurnGate({ perWorkspace: 2.9 });
    g.acquire("ws-1");
    g.acquire("ws-1");
    expect(() => g.acquire("ws-1")).toThrow(TurnRejectedError);
  });
});

describe("TurnGate — accounting integrity", () => {
  // A double release would drive the counter below zero and permanently inflate
  // capacity — a leak that surfaces as an outage much later, far from its cause.
  test("release is idempotent and never inflates capacity", () => {
    const g = new TurnGate({ perWorkspace: 1, global: 1 });
    const a = g.acquire("ws-1");
    a.release();
    a.release();
    a.release();
    expect(g.active).toBe(0);
    expect(g.activeFor("ws-1")).toBe(0);
    g.acquire("ws-1");
    expect(() => g.acquire("ws-1")).toThrow(TurnRejectedError);
  });

  test("a refused acquire does not consume a slot", () => {
    const g = new TurnGate({ perWorkspace: 1 });
    const a = g.acquire("ws-1");
    expect(() => g.acquire("ws-1")).toThrow();
    expect(() => g.acquire("ws-1")).toThrow();
    a.release();
    // If a refusal had leaked a count, this would still be refused.
    expect(() => g.acquire("ws-1")).not.toThrow();
  });

  test("the per-workspace map does not grow unboundedly", () => {
    const g = new TurnGate({ perWorkspace: 1 });
    for (let i = 0; i < 200; i++) g.acquire(`ws-${i}`).release();
    expect(g.active).toBe(0);
    for (let i = 0; i < 200; i++) expect(g.activeFor(`ws-${i}`)).toBe(0);
  });
});

describe("TurnGate — cosmetic (title) budget, P20 round 2", () => {
  // THE REGRESSION this budget exists for: titling starts the instant a turn
  // finishes, so sharing the turn counter meant cosmetics deterministically took
  // the slot and refused the user's very next message.
  test("a title spawn never consumes a turn slot", () => {
    const g = new TurnGate({ perWorkspace: 1, global: 1, titles: 1 });
    const title = g.acquireTitle();
    expect(title).toBeDefined();
    // A real turn must still be admitted while a title is in flight.
    expect(() => g.acquire("ws-1")).not.toThrow();
    expect(g.active).toBe(1);
    expect(g.activeTitles).toBe(1);
  });

  test("a turn in flight never blocks a title, and vice versa", () => {
    const g = new TurnGate({ perWorkspace: 1, titles: 1 });
    g.acquire("ws-1");
    expect(g.acquireTitle()).toBeDefined();
  });

  // ...but decoration is still BOUNDED — that was the original blocker.
  test("titles are capped, and refusal is a return not a throw", () => {
    const g = new TurnGate({ titles: 1 });
    const a = g.acquireTitle();
    expect(a).toBeDefined();
    expect(g.acquireTitle()).toBeUndefined();
    a?.release();
    expect(g.acquireTitle()).toBeDefined();
  });

  test("title release is idempotent", () => {
    const g = new TurnGate({ titles: 1 });
    const a = g.acquireTitle();
    a?.release();
    a?.release();
    expect(g.activeTitles).toBe(0);
    expect(g.acquireTitle()).toBeDefined();
  });

  test("no titles limit means unbounded, matching the other knobs", () => {
    const g = new TurnGate({});
    for (let i = 0; i < 25; i++) expect(g.acquireTitle()).toBeDefined();
    expect(g.activeTitles).toBe(25);
  });
});
