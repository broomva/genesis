import { describe, expect, test } from "bun:test";
import {
  APPLY_COMMAND,
  applyOperatorCommand,
  isOperator,
  isOperatorToken,
  parseOperatorCommand,
} from "./operator";
import type { TenantRecord } from "./tenants";

const b64 = (v: string) => Buffer.from(v, "utf8").toString("base64url");
const OUR_NUMBER = "1314014011788509";
const thread = (waId: string) => `kapso:${b64(OUR_NUMBER)}:${b64(waId)}`;
const OPERATOR = "573017758620";
const TENANT = "573214994114";
const NOW = "2026-08-23T06:00:00.000Z";

const rec = (over: Partial<TenantRecord> = {}): TenantRecord => ({
  id: TENANT,
  channel: "kapso",
  state: "active",
  requestedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

/** In-memory stand-in for TenantStore. */
function fakeStore(seed: TenantRecord[] = []) {
  const m = new Map(seed.map((r) => [r.id, r]));
  return {
    get: (id: string) => m.get(id),
    put: (r: TenantRecord) => void m.set(r.id, r),
    list: () => [...m.values()],
  };
}

describe("isOperator — the whole gate", () => {
  test("the configured principal is the operator", () => {
    expect(isOperator(thread(OPERATOR), OPERATOR)).toBe(true);
    expect(isOperator(thread(OPERATOR), "+57 301 775 8620")).toBe(true);
  });

  test("any other sender is not, including a tenant", () => {
    expect(isOperator(thread(TENANT), OPERATOR)).toBe(false);
  });

  test("UNSET means nobody is the operator, never everybody", () => {
    // The fail-open version of this line hands the registry to every sender on
    // a public phone number.
    expect(isOperator(thread(OPERATOR), undefined)).toBe(false);
    expect(isOperator(thread(OPERATOR), "")).toBe(false);
    expect(isOperator(thread(OPERATOR), "   ")).toBe(false);
  });

  test("it matches the SENDER, not our own number in part 1", () => {
    // The bug this codebase already shipped once: the principal is part 2 of
    // the thread id (the waId). Part 1 is OUR phone number and is identical on
    // every inbound message, so a check reading it would make EVERY sender the
    // operator.
    expect(isOperator(thread(TENANT), OUR_NUMBER)).toBe(false);
  });

  test("an unresolvable thread id is not the operator", () => {
    expect(isOperator("kapso:not-base64!!", OPERATOR)).toBe(false);
    expect(isOperator("", OPERATOR)).toBe(false);
    expect(isOperator(`telegram:${OPERATOR}`, OPERATOR)).toBe(false);
  });

  test("a substring or padded number does not match", () => {
    expect(isOperator(thread(`9${OPERATOR}`), OPERATOR)).toBe(false);
    expect(isOperator(thread(OPERATOR.slice(1)), OPERATOR)).toBe(false);
  });
});

describe("parseOperatorCommand", () => {
  test("operator tokens are recognised, ordinary ones are not", () => {
    expect(isOperatorToken("allow")).toBe(true);
    expect(isOperatorToken("ALLOW")).toBe(true);
    expect(isOperatorToken("status")).toBe(false);
    expect(parseOperatorCommand("status", "")).toBeUndefined();
  });

  test("allow / revoke need both arguments", () => {
    expect(parseOperatorCommand("allow", `${TENANT} docs.python.org`)).toEqual({
      kind: "allow",
      id: TENANT,
      domain: "docs.python.org",
    });
    expect(parseOperatorCommand("allow", TENANT)).toEqual({
      error: "usage: /allow <number> <domain>",
    });
  });

  test("a pasted number in any spelling resolves to the registry key", () => {
    // A phone contact card gives you spaces and dashes. Every one of these is
    // the same tenant, and the domain is still the domain.
    for (const spelling of ["+57 321 499 4114", "+57 321-499-4114", "(57) 321 4994114", TENANT]) {
      expect(parseOperatorCommand("allow", `${spelling} x.example.com`)).toEqual({
        kind: "allow",
        id: TENANT,
        domain: "x.example.com",
      });
    }
    expect(parseOperatorCommand("tapprove", "+57 321 499 4114")).toEqual({
      kind: "approve",
      id: TENANT,
    });
    expect(parseOperatorCommand("policy", "+57 321 499 4114 trusted")).toEqual({
      kind: "policy",
      id: TENANT,
      policy: "trusted",
    });
  });

  test("a lone argument is a usage error, not a half-parsed pair", () => {
    expect(parseOperatorCommand("allow", TENANT)).toHaveProperty("error");
    expect(parseOperatorCommand("allow", "docs.python.org")).toHaveProperty("error");
    expect(parseOperatorCommand("allow", "")).toHaveProperty("error");
  });

  test("an unknown policy is refused rather than defaulted", () => {
    expect(parseOperatorCommand("policy", `${TENANT} root`)).toHaveProperty("error");
    expect(parseOperatorCommand("policy", `${TENANT} trusted`)).toEqual({
      kind: "policy",
      id: TENANT,
      policy: "trusted",
    });
  });
});

describe("applyOperatorCommand", () => {
  test("approving a domain writes it and asks for the apply step", () => {
    const store = fakeStore([rec()]);
    const r = applyOperatorCommand(
      { kind: "allow", id: TENANT, domain: "docs.python.org" },
      store,
      NOW,
    );
    expect(r.needsApply).toBe(true);
    expect(store.get(TENANT)?.domains).toEqual(["docs.python.org"]);
    expect(r.reply).toContain("docs.python.org");
    // The reply must carry the command that makes it real, or the operator is
    // told "done" about a change no tenant can yet use.
    expect(r.reply).toContain(APPLY_COMMAND);
  });

  test("a hostile domain changes nothing and says why", () => {
    const store = fakeStore([rec()]);
    const r = applyOperatorCommand(
      { kind: "allow", id: TENANT, domain: "evil.com/#.github.com" },
      store,
      NOW,
    );
    expect(r.needsApply).toBe(false);
    expect(store.get(TENANT)?.domains).toBeUndefined();
    expect(r.reply).toContain("❌");
  });

  test("an unknown tenant is refused, never invented", () => {
    const store = fakeStore([]);
    const r = applyOperatorCommand({ kind: "approve", id: "573000000000" }, store, NOW);
    expect(r.needsApply).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  test("a no-op does not claim an apply is needed", () => {
    const store = fakeStore([rec({ domains: ["docs.python.org"] })]);
    const r = applyOperatorCommand(
      { kind: "allow", id: TENANT, domain: "docs.python.org" },
      store,
      NOW,
    );
    expect(r.needsApply).toBe(false);
    expect(r.reply).toContain("No change");
  });

  test("the tier moves and reports both ends", () => {
    const store = fakeStore([rec()]);
    const r = applyOperatorCommand({ kind: "policy", id: TENANT, policy: "trusted" }, store, NOW);
    expect(store.get(TENANT)?.policy).toBe("trusted");
    expect(r.needsApply).toBe(true);
    expect(r.reply).toContain("trusted");
  });
});
