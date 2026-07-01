import { afterEach, describe, expect, test } from "bun:test";
import {
  type ChatStatus,
  deriveRunMode,
  fetchThreadStatus,
  isTerminalPhase,
} from "./thread-status";
import type { ThreadPhase } from "./threads";

const origFetch = global.fetch;
afterEach(() => {
  global.fetch = origFetch;
});

describe("isTerminalPhase (BRO-1640)", () => {
  test("done / blocked / idle / null are terminal", () => {
    for (const p of ["done", "blocked", "idle", null, undefined] as const) {
      expect(isTerminalPhase(p)).toBe(true);
    }
  });
  test("running / awaiting are NOT terminal (keep polling)", () => {
    expect(isTerminalPhase("running")).toBe(false);
    expect(isTerminalPhase("awaiting")).toBe(false);
  });
});

describe("deriveRunMode (BRO-1640 — dropped stream ≠ crash)", () => {
  const mode = (
    liveStatus: ChatStatus,
    serverPhase: ThreadPhase | null,
    reconciling = false,
    unresolved = false,
  ) => deriveRunMode({ liveStatus, serverPhase, reconciling, unresolved });

  test("a live stream always reads as streaming", () => {
    expect(mode("submitted", null)).toBe("streaming");
    expect(mode("streaming", "running")).toBe("streaming");
  });

  test("no live stream but the server turn is running → working (the core fix)", () => {
    // iOS backgrounded → stream errored → but the turn is still running server-side.
    expect(mode("error", "running")).toBe("working");
    // Opened an already-running thread with no live stream (status ready).
    expect(mode("ready", "running")).toBe("working");
    expect(mode("ready", "awaiting")).toBe("working");
  });

  test("a BLOCKED server turn is a real error even after clearError un-wedged (P20 CRIT-6)", () => {
    // Server truth wins: blocked → error regardless of the live status (which is
    // "ready" once clearError ran). The old code returned idle here → silent swallow.
    expect(mode("ready", "blocked")).toBe("error");
    expect(mode("error", "blocked")).toBe("error");
  });

  test("errored while reconciling → reconnecting (transient, not a crash)", () => {
    expect(mode("error", null, true)).toBe("reconnecting");
    // Even a done phase, mid-reconcile, is a brief reconnect (about to refetch).
    expect(mode("error", "done", true)).toBe("reconnecting");
  });

  test("errored + unconfirmable via the engine → a RETRYABLE error, never a silent idle (P20 CRIT-6/HIGH-1)", () => {
    // The stream failed and a status fetch returned null (engine unreachable): don't
    // pretend it's idle — surface a retryable error.
    expect(mode("ready", null, false, true)).toBe("error");
    expect(mode("error", "idle")).toBe("error");
    expect(mode("error", null)).toBe("error");
  });

  test("errored but the server turn already finished (done) → reconnecting (about to refetch)", () => {
    expect(mode("error", "done")).toBe("reconnecting");
  });

  test("settled → idle", () => {
    expect(mode("ready", "done")).toBe("idle");
    expect(mode("ready", "idle")).toBe("idle");
    expect(mode("ready", null)).toBe("idle");
  });
});

describe("fetchThreadStatus (BRO-1640)", () => {
  function stub(ok: boolean, body: unknown, opts?: { throws?: boolean }): void {
    global.fetch = (async () => {
      if (opts?.throws) throw new Error("network down");
      return { ok, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  test("returns the phase from the control status response", async () => {
    stub(true, { ok: true, phase: "running", alive: false });
    expect(await fetchThreadStatus("t1")).toBe("running");
  });

  test("null on a non-ok response", async () => {
    stub(false, { error: "unauthorized" });
    expect(await fetchThreadStatus("t1")).toBeNull();
  });

  test("null on a thrown fetch", async () => {
    stub(true, {}, { throws: true });
    expect(await fetchThreadStatus("t1")).toBeNull();
  });

  test("null on a missing / unknown phase value (never a false terminal)", async () => {
    stub(true, { ok: true });
    expect(await fetchThreadStatus("t1")).toBeNull();
    stub(true, { phase: "bogus" });
    expect(await fetchThreadStatus("t1")).toBeNull();
  });
});
