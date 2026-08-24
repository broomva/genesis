import { describe, expect, test } from "bun:test";
import {
  AgentReportedError,
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
    expect(classifyDispatchFailure(e)).toBe("unknown");
  });

  // Captured from bun 1.3.14: a plain Error, bun-native code, NO cause chain.
  test("bun's real connect failure shape → backend-unreachable", () => {
    const e = Object.assign(
      new Error("Unable to connect. Is the computer able to access the url?"),
      {
        code: "ConnectionRefused",
      },
    );
    expect(classifyDispatchFailure(e)).toBe("backend-unreachable");
  });

  test("classification is TOTAL — a hostile getter cannot make it throw", () => {
    const hostile = {
      get code() {
        throw new Error("boom");
      },
      get message() {
        throw new Error("boom");
      },
    };
    expect(classifyDispatchFailure(hostile)).toBe("unknown");
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
    expect(classifyDispatchFailure(new Error("chat endpoint gave 503"))).toBe("unknown");
  });

  // Anchored: an agent's OWN text quoting the phrase must not read as transport.
  test("an agent error quoting the HTTP phrase is not read as a transport status", () => {
    const e = new AgentReportedError("the tool said: Genesis /api/chat failed: HTTP 500 (nested)");
    expect(classifyDispatchFailure(e)).toBe("agent-error");
  });
});

describe("classifyDispatchFailure — agent vs unknown", () => {
  // genesisStream rethrows the agent's own `error` part text.
  // POSITIVE attribution only: a bare Error could be thread.post, a parser, or the
  // stream consumer. Calling those "agent-error" misdiagnosed channel failures.
  test("a MARKED agent error → agent-error", () => {
    expect(classifyDispatchFailure(new AgentReportedError("tool execution failed"))).toBe(
      "agent-error",
    );
  });
  test("an UNMARKED bare Error → unknown, not agent-error", () => {
    expect(classifyDispatchFailure(new Error("thread.post failed"))).toBe("unknown");
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

// ── BRO-2260 cross-package contract ──────────────────────────────────────────
// The supervisor's bounded-turn errors reach this classifier as agent-reported
// text. Classification anchors on their message PREFIX, which means a reworded
// message in @genesis/core or @genesis/runner would silently degrade the channel
// back to "the agent failed" — the exact regression this ticket removed.
//
// So pin the REAL error objects, not hand-written strings. A string fixture would
// keep passing after the source message changed, which is the failure mode this
// test exists to prevent.
import { TurnRejectedError } from "../../../packages/core/src/concurrency";
import { TurnReapedError } from "../../../packages/runner/src/watchdog";

/** EVERY DispatchFailure member. The previous list named four of eight, so the
 *  "all kinds" assertions silently skipped half of them — including the two the
 *  same PR had just added (P20 minor). The `satisfies` makes the compiler fail if
 *  a member is added to the union and not listed here, so the gap cannot reopen. */
const ALL_KINDS = [
  "backend-unreachable",
  "backend-error",
  "unauthorized",
  "timeout",
  "capacity-own",
  "capacity-server",
  "turn-timeout-idle",
  "turn-timeout-total",
  "agent-error",
  "unknown",
] as const satisfies readonly DispatchFailure[];

/** Wrap as the stream does: a dispatch error arrives agent-reported. */
class AgentReportedLike extends Error {
  // The duck-typed flag the classifier actually checks (see `isAgentReported`).
  readonly isAgentReported = true;
  constructor(m: string) {
    super(m);
    this.name = "AgentReportedError";
  }
}

describe("bounded-turn errors reach the sender as themselves (BRO-2260)", () => {
  test("a per-workspace refusal classifies as capacity-own", () => {
    const real = new TurnRejectedError("workspace", 1);
    expect(classifyDispatchFailure(new AgentReportedLike(real.message))).toBe("capacity-own");
  });

  // SPLIT deliberately (P20 round 2): a global refusal is caused by someone else's
  // work and may be the sender's FIRST message, so telling them to "wait for your
  // previous reply" points at a reply that will never exist.
  test("a global refusal classifies as capacity-server, not capacity-own", () => {
    const real = new TurnRejectedError("global", 2);
    expect(classifyDispatchFailure(new AgentReportedLike(real.message))).toBe("capacity-server");
  });

  test("the two capacity messages say different things", () => {
    const own = dispatchFailureMessage("capacity-own");
    const server = dispatchFailureMessage("capacity-server");
    expect(own).not.toBe(server);
    expect(own).toMatch(/previous message/i);
    // Must NOT blame the sender's own traffic for someone else's slot.
    expect(server).not.toMatch(/previous message/i);
  });

  // The TOTAL reap message used to promise "Nothing was saved". That was false —
  // the user turn is persisted and the agent's file/command side effects survive
  // the kill — and acting on it would make a resend duplicate real mutations.
  test("the total-timeout message does not promise a clean slate", () => {
    const m = dispatchFailureMessage("turn-timeout-total");
    expect(m).not.toMatch(/nothing was saved/i);
    expect(m).toMatch(/part-way|already be done/i);
  });

  // BRO-2307. The two clocks mean different things, so they must say different
  // things — the same defect shape P20 round 2 found in `capacity`, one layer over.
  test("the two reap clocks classify separately", () => {
    const idle = new TurnReapedError("idle", 900_000, 900_000);
    const total = new TurnReapedError("total", 1_800_000, 1_800_000);
    expect(classifyDispatchFailure(new AgentReportedLike(idle.message))).toBe("turn-timeout-idle");
    expect(classifyDispatchFailure(new AgentReportedLike(total.message))).toBe(
      "turn-timeout-total",
    );
  });

  test("an idle reap does not claim the turn was too big", () => {
    const m = dispatchFailureMessage("turn-timeout-idle");
    // It stalled; size was never the issue, and telling the user to shrink the
    // task points them away from the actual cause.
    expect(m).not.toMatch(/took too long|smaller/i);
    expect(m).not.toBe(dispatchFailureMessage("turn-timeout-total"));
  });

  // P20 caught the over-correction: dropping "took too long" is right, dropping
  // the PARTIAL-WORK warning is not. Stdout going quiet does not mean nothing
  // happened — a turn can mutate files then stall, so a bare "send it again"
  // invites a duplicate mutation. BOTH clocks must keep the warning.
  test("BOTH reap messages warn that work may already be done", () => {
    for (const kind of ["turn-timeout-idle", "turn-timeout-total"] as const) {
      expect(dispatchFailureMessage(kind)).toMatch(/may already be done/i);
    }
  });

  test("no message promises that a retry will succeed", () => {
    for (const kind of ["turn-timeout-idle", "turn-timeout-total"] as const) {
      expect(dispatchFailureMessage(kind)).not.toMatch(/usually|will work|should work/i);
    }
  });

  test("the messages are actionable and disclose nothing about the box", () => {
    for (const kind of ALL_KINDS) {
      const m = dispatchFailureMessage(kind);
      expect(m.length).toBeGreaterThan(20);
      // "Actionable" is not always "try again". `unauthorized` deliberately says
      // retrying will NOT help and names an operator — asserting /again/ over the
      // full set caught that the old four-member list had never exercised it.
      // Every message must tell the reader what to do next, whichever that is.
      expect(m).toMatch(/again|smaller|operator|check|wait/i);
      // No paths, hosts, workspace ids or counts — a shared number is read by
      // people who are not the operator.
      expect(m).not.toMatch(/\/home|ws-|localhost|127\.0\.0\.1|genesis-/);
    }
  });

  // NEGATIVE CONTROL: an ordinary agent failure must still be agent-error, or the
  // two new branches would be swallowing everything and the tests above would pass
  // for the wrong reason.
  test("an ordinary agent error is still agent-error", () => {
    expect(classifyDispatchFailure(new AgentReportedLike("Tool use failed: ENOENT"))).toBe(
      "agent-error",
    );
    expect(classifyDispatchFailure(new AgentReportedLike("boom"))).toBe("agent-error");
  });

  // A mid-string match would let agent output pick its own classification.
  test("the prefixes are anchored, not substring-matched", () => {
    const smuggled = new AgentReportedLike(
      "I tried to run it and the tool said: You already have 1 turn running.",
    );
    expect(classifyDispatchFailure(smuggled)).toBe("agent-error");
  });
});
