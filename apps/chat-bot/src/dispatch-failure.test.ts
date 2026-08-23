import { describe, expect, test } from "bun:test";
import {
  type DispatchFailure,
  classifyDispatchFailure,
  dispatchFailureMessage,
} from "./dispatch-failure";

/** How Node/Bun fetch actually surfaces a connection failure: a TypeError whose
 *  `cause` carries the errno. Reconstructed here rather than asserted flat, so the
 *  cause-chain walk is what is under test. */
function fetchError(code: string): TypeError {
  const e = new TypeError("fetch failed");
  (e as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return e;
}

describe("classifyDispatchFailure — the two failures the incident could not tell apart", () => {
  // 17:09-18:5x on srv1692698: genesis-api was DOWN, the fetch never connected.
  test("api down (ECONNREFUSED) → backend-unreachable", () => {
    expect(classifyDispatchFailure(fetchError("ECONNREFUSED"))).toBe("backend-unreachable");
  });

  // 18:5x onward: api UP, returned 200 and {"type":"start"}, then nothing for
  // 170s. The bot's own abort/timeout is what surfaces.
  test("stream opened then stalled (AbortError) → timeout, NOT unreachable", () => {
    const e = new Error("The operation was aborted");
    e.name = "AbortError";
    expect(classifyDispatchFailure(e)).toBe("timeout");
  });

  // The whole point: these two must not collapse to the same class.
  test("the two incident failures classify DIFFERENTLY", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyDispatchFailure(fetchError("ECONNREFUSED"))).not.toBe(
      classifyDispatchFailure(abort),
    );
  });
});

describe("classifyDispatchFailure — transport codes", () => {
  test.each([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
    "ECONNRESET",
    "EPIPE",
  ])("%s → backend-unreachable", (code) => {
    expect(classifyDispatchFailure(fetchError(code))).toBe("backend-unreachable");
  });

  test("ETIMEDOUT → timeout, not unreachable (it connected, then gave up)", () => {
    expect(classifyDispatchFailure(fetchError("ETIMEDOUT"))).toBe("timeout");
  });

  test("a bare fetch TypeError with no errno still reads as unreachable", () => {
    expect(classifyDispatchFailure(new TypeError("fetch failed"))).toBe("backend-unreachable");
  });

  test("walks a nested cause chain, not just the top level", () => {
    const inner = Object.assign(new Error("boom"), { code: "ECONNREFUSED" });
    const mid = Object.assign(new Error("mid"), { cause: inner });
    const outer = new TypeError("fetch failed");
    (outer as { cause?: unknown }).cause = mid;
    expect(classifyDispatchFailure(outer)).toBe("backend-unreachable");
  });

  test("a self-referential cause chain terminates instead of hanging", () => {
    const e = new Error("loop") as Error & { cause?: unknown };
    e.cause = e;
    expect(classifyDispatchFailure(e)).toBe("agent-error");
  });
});

describe("classifyDispatchFailure — HTTP status from genesis.ts", () => {
  const httpErr = (n: number) => new Error(`Genesis /api/chat failed: HTTP ${n}`);

  test.each([401, 403])("%d → unauthorized (retrying will not help)", (n) => {
    expect(classifyDispatchFailure(httpErr(n))).toBe("unauthorized");
  });
  test.each([500, 502, 503, 400, 404])("%d → backend-error", (n) => {
    expect(classifyDispatchFailure(httpErr(n))).toBe("backend-error");
  });

  // The status is parsed, not the prose. A reworded message must fall through to
  // agent-error rather than being silently reclassified as a backend problem.
  test("a reworded HTTP message is NOT guessed at", () => {
    expect(classifyDispatchFailure(new Error("chat endpoint gave 503"))).toBe("agent-error");
  });
});

describe("classifyDispatchFailure — agent vs unknown", () => {
  // genesisStream rethrows the agent's own `error` part text.
  test("an agent error part → agent-error", () => {
    expect(classifyDispatchFailure(new Error("tool execution failed"))).toBe("agent-error");
  });
  test.each([[null], [undefined], [""], [new Error("")]])("%p → unknown", (v) => {
    expect(classifyDispatchFailure(v)).toBe("unknown");
  });
});

describe("dispatchFailureMessage — tenant-visible, and must leak nothing", () => {
  const KINDS: DispatchFailure[] = [
    "backend-unreachable",
    "backend-error",
    "unauthorized",
    "timeout",
    "agent-error",
    "unknown",
  ];

  test("every kind has a distinct message", () => {
    const msgs = KINDS.map(dispatchFailureMessage);
    expect(new Set(msgs).size).toBe(KINDS.length);
  });

  // The reader may be an untrusted tenant on a shared number. Nothing from the
  // throw site may reach the channel.
  test("the error's own text NEVER appears in the tenant message", () => {
    const secret = "/home/agent/.config/genesis-bot/env.sh TOKEN=sk-abc123";
    const e = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error(secret), { code: "ECONNREFUSED" }),
    });
    const msg = dispatchFailureMessage(classifyDispatchFailure(e));
    expect(msg).not.toContain(secret);
    expect(msg).not.toContain("sk-abc123");
    expect(msg).not.toContain("/home/agent");
  });

  test("unauthorized tells the reader retrying will not help", () => {
    expect(dispatchFailureMessage("unauthorized")).toContain("not help");
  });

  test("unknown keeps the original wording as the fallback", () => {
    expect(dispatchFailureMessage("unknown")).toBe(
      "⚠️ Something went wrong handling that — please try again.",
    );
  });

  test("every message is short enough for one WhatsApp bubble", () => {
    for (const k of KINDS) expect(dispatchFailureMessage(k).length).toBeLessThan(200);
  });
});
