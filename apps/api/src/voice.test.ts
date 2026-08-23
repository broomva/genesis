import { describe, expect, test } from "bun:test";
import {
  MAX_REQUEST_CHARS,
  VoiceValidationError,
  buildTicket,
  clampRequest,
  normalizeCallerId,
  resolveCaller,
  secretMatches,
} from "./voice";

const CARLOS = { id: "573017758620", name: "Carlos" };
const PRINCIPALS = [CARLOS, { id: "573214994114" }];

describe("secretMatches — the voice surface's only gate", () => {
  test("an UNSET expected secret authorizes nothing, including empty input", () => {
    // The fail-closed direction. If an unset secret compared equal to an unset
    // header, deploying without the env var would publish an OPEN endpoint that
    // looks configured — the caller sees 200s and nothing reports it.
    expect(secretMatches(undefined, "")).toBe(false);
    expect(secretMatches("", "")).toBe(false);
    expect(secretMatches("anything", "")).toBe(false);
  });

  test("matches only the exact secret", () => {
    expect(secretMatches("s3cret", "s3cret")).toBe(true);
    expect(secretMatches("s3crey", "s3cret")).toBe(false);
    expect(secretMatches(undefined, "s3cret")).toBe(false);
  });

  test("a length mismatch is false, not a throw", () => {
    // timingSafeEqual throws on unequal lengths; letting that escape would turn
    // a wrong guess into a 500 and a length oracle.
    expect(() => secretMatches("short", "muchlongersecret")).not.toThrow();
    expect(secretMatches("short", "muchlongersecret")).toBe(false);
    expect(secretMatches("muchlongersecret", "short")).toBe(false);
  });
});

describe("normalizeCallerId — must agree with the WhatsApp allowlist", () => {
  test("reduces every spelling of one number to one id", () => {
    for (const spelling of [
      "+57 301 775 8620",
      "573017758620",
      "+573017758620",
      "57-301-7758620",
    ]) {
      expect(normalizeCallerId(spelling)).toBe("573017758620");
    }
  });

  test("DRIFT GUARD: same rule as allowlist.ts normalizePhone (digits only)", () => {
    // If these two implementations ever diverge, an allowlisted caller resolves
    // as unknown and silently drops to take-a-message. Nothing errors. This test
    // is the tripwire until the rule lives in one shared module (#107).
    const allowlistRule = (v: string) => v.replace(/\D/g, "");
    for (const s of ["+57 (301) 775-8620", "  573017758620  ", "tel:+573017758620", ""]) {
      expect(normalizeCallerId(s)).toBe(allowlistRule(s));
    }
  });
});

describe("resolveCaller — caller id routes, it does not authorize", () => {
  test("a known caller resolves to their principal", () => {
    expect(resolveCaller("+57 301 775 8620", PRINCIPALS)).toEqual({
      kind: "known",
      principal: CARLOS,
    });
  });

  test("an unknown caller is a NORMAL outcome, not an error", () => {
    expect(resolveCaller("15550001111", PRINCIPALS)).toEqual({ kind: "unknown" });
  });

  test("absent, blank, and non-numeric caller ids are unknown, never a crash", () => {
    for (const v of [undefined, "", "   ", "anonymous", "+++"]) {
      expect(resolveCaller(v, PRINCIPALS)).toEqual({ kind: "unknown" });
    }
  });
});

describe("buildTicket", () => {
  const NOW = "2026-08-23T01:00:00.000Z";

  test("a known caller gets a delivery target from the ALLOWLIST", () => {
    const t = buildTicket(
      { callerId: "573017758620", request: "call me back" },
      PRINCIPALS,
      NOW,
      "t1",
    );
    expect(t.deliverTo).toBe("573017758620");
  });

  test("an unknown caller gets NO delivery target", () => {
    const t = buildTicket({ callerId: "15550001111", request: "hi" }, PRINCIPALS, NOW, "t2");
    expect(t.deliverTo).toBeUndefined();
    expect(t.callerId).toBe("15550001111"); // recorded for triage, not trusted
  });

  test("delivery target can NEVER be taken from the request body", () => {
    // The attack this closes: a caller asks us to deliver to a number that is
    // not theirs. Delivery comes from the matched principal or nowhere, so an
    // extra field in the body has no effect.
    const t = buildTicket(
      { callerId: "15550001111", request: "x", deliverTo: "573017758620" } as never,
      PRINCIPALS,
      NOW,
      "t3",
    );
    expect(t.deliverTo).toBeUndefined();
  });

  test("an empty or whitespace request is rejected with a caller-safe message", () => {
    for (const r of [undefined, "", "   "]) {
      expect(() =>
        buildTicket({ callerId: "573017758620", request: r }, PRINCIPALS, NOW, "t4"),
      ).toThrow(VoiceValidationError);
    }
  });

  test("a long transcript is truncated AND marked as truncated", () => {
    const long = "a".repeat(MAX_REQUEST_CHARS + 500);
    const t = buildTicket({ callerId: "573017758620", request: long }, PRINCIPALS, NOW, "t5");
    expect(t.request.length).toBeLessThan(long.length);
    expect(t.request.endsWith("… [truncated]")).toBe(true);
  });

  test("clampRequest leaves a normal request untouched", () => {
    expect(clampRequest("  book me a slot  ")).toBe("book me a slot");
  });
});
