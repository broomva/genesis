import { describe, expect, test } from "bun:test";
import {
  MAX_TENANT_DOMAINS,
  TenantDomainError,
  type TenantRecord,
  admit,
  allowDomain,
  approve,
  denyDomain,
  egressDomainsFor,
  normalizeDomain,
  policyOf,
  pruneTimestamps,
  rateLimit,
  setPolicy,
  suspend,
  webFetchHost,
  webFetchRulesFor,
} from "./tenants";

const b64 = (v: string) => Buffer.from(v, "utf8").toString("base64url");
const thread = (waId: string) => `kapso:${b64("1314014011788509")}:${b64(waId)}`;
const NOW = "2026-08-23T02:00:00.000Z";
const rec = (over: Partial<TenantRecord> = {}): TenantRecord => ({
  id: "573001234567",
  channel: "kapso",
  state: "active",
  requestedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

describe("admit — the gate, now reading data instead of an env var", () => {
  test("an ACTIVE tenant is served", () => {
    const d = admit(thread("573001234567"), () => rec(), NOW);
    expect(d.kind).toBe("serve");
    if (d.kind === "serve") expect(d.tenant.lastSeenAt).toBe(NOW);
  });

  test("an UNKNOWN sender becomes pending and is acknowledged ONCE", () => {
    const d = admit(thread("573009999999"), () => undefined, NOW);
    expect(d.kind).toBe("acknowledge");
    if (d.kind !== "acknowledge") return;
    expect(d.tenant.state).toBe("pending");
    expect(d.tenant.id).toBe("573009999999");
    expect(d.tenant.acknowledgedAt).toBe(NOW);
  });

  test("a PENDING tenant is ignored, NOT acknowledged again", () => {
    // The spam-amplifier guard. If every message from a pending requester got a
    // reply, anyone who found the number could make it emit unbounded outbound
    // traffic — and pay for it.
    const d = admit(thread("573001234567"), () => rec({ state: "pending" }), NOW);
    expect(d.kind).toBe("ignore");
  });

  test("a SUSPENDED tenant is ignored SILENTLY", () => {
    // Silence is deliberate: a reply would tell a suspended person exactly when
    // they were suspended, and by whom it is enforced.
    const d = admit(thread("573001234567"), () => rec({ state: "suspended" }), NOW);
    expect(d.kind).toBe("ignore");
  });

  test("an unresolvable thread id is IGNORED, never provisionally admitted", () => {
    for (const bad of ["kapso:abc:!!!", "kapso:MTIzNDU2:", "kapso:MTIzNDU2", "kapso:a:b:c:d:e"]) {
      const d = admit(bad, () => rec(), NOW);
      expect(d.kind).toBe("ignore");
    }
  });

  test("a non-WhatsApp thread never reaches this registry", () => {
    expect(admit("telegram:547052379", () => rec(), NOW).kind).toBe("ignore");
  });

  test("the lookup key is the NORMALIZED number", () => {
    // The requester's waId arrives as digits; an operator may have typed the
    // record with punctuation. Both must resolve to one tenant or a person gets
    // acknowledged forever while their approved record sits unused.
    const seen: string[] = [];
    admit(
      thread("573001234567"),
      (id) => {
        seen.push(id);
        return undefined;
      },
      NOW,
    );
    expect(seen).toEqual(["573001234567"]);
  });
});

describe("state transitions", () => {
  test("approve moves pending -> active and stamps the date", () => {
    const a = approve(rec({ state: "pending" }), NOW, "wife");
    expect(a.state).toBe("active");
    expect(a.approvedAt).toBe(NOW);
    expect(a.note).toBe("wife");
  });

  test("approving an ALREADY-active tenant does not re-stamp it", () => {
    // Losing the original approvedAt would destroy the only audit record of
    // when this person was let in.
    const first = approve(rec({ state: "pending" }), "2026-08-01T00:00:00.000Z");
    const again = approve(first, NOW);
    expect(again.approvedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  test("approve clears a prior suspension", () => {
    const s = suspend(rec(), "2026-08-02T00:00:00.000Z");
    expect(approve(s, NOW).suspendedAt).toBeUndefined();
  });

  test("suspend works from pending (a rejection) and KEEPS the record", () => {
    const s = suspend(rec({ state: "pending" }), NOW, "spam");
    expect(s.state).toBe("suspended");
    // Deleting instead would make their next message look like a fresh request
    // and re-acknowledge someone already rejected.
    expect(s.id).toBe("573001234567");
    expect(s.requestedAt).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("rateLimit — sliding window", () => {
  const WINDOW = 60_000;

  test("allows under the limit", () => {
    expect(rateLimit([1000, 2000], 3000, WINDOW, 5).allowed).toBe(true);
  });

  test("blocks at the limit and says when to retry", () => {
    const d = rateLimit([1000, 2000, 3000], 4000, WINDOW, 3);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBe(1000 + WINDOW - 4000);
  });

  test("timestamps outside the window do not count", () => {
    expect(rateLimit([1, 2, 3], 100_000, WINDOW, 3).allowed).toBe(true);
  });

  test("SLIDING, not fixed-bucket — no double burst at a boundary", () => {
    // A fixed bucket lets `max` land at the end of one window and `max` again
    // at the start of the next: 2x the limit in an instant, which is the exact
    // burst the limit exists to stop.
    const hits = [59_000, 59_500, 59_900];
    expect(rateLimit(hits, 60_100, WINDOW, 3).allowed).toBe(false);
  });

  test("max <= 0 blocks with a FINITE retry, not Infinity", () => {
    // Without the explicit guard this still reports allowed:false — by falling
    // through to Math.min(...[]) === Infinity. `allowed` alone therefore does
    // not distinguish the guard from its absence; a mutation sweep caught that
    // this assertion was vacuous. retryAfterMs is what the guard actually
    // provides, and Infinity would poison any caller that sleeps on it.
    const d = rateLimit([], 1000, WINDOW, 0);
    expect(d.allowed).toBe(false);
    expect(Number.isFinite(d.retryAfterMs)).toBe(true);
    expect(d.retryAfterMs).toBe(WINDOW);
  });

  test("pruneTimestamps keeps only the window", () => {
    expect(pruneTimestamps([1, 2, 59_000, 59_999], 60_000, WINDOW)).toEqual([1, 2, 59_000, 59_999]);
    expect(pruneTimestamps([1, 2, 59_000], 120_000, WINDOW)).toEqual([]);
  });
});

describe("normalizeDomain — hostile input, because the tenant proposes the string", () => {
  test("plain and wildcard hosts are accepted, case-folded and trimmed", () => {
    expect(normalizeDomain("Example.COM")).toBe("example.com");
    expect(normalizeDomain("  docs.python.org  ")).toBe("docs.python.org");
    expect(normalizeDomain("*.skills.sh")).toBe("*.skills.sh");
    expect(normalizeDomain("a-b.example.co.uk")).toBe("a-b.example.co.uk");
  });

  test("a wildcard over a public suffix is refused — one yes would open a TLD", () => {
    expect(normalizeDomain("*")).toBeUndefined();
    expect(normalizeDomain("*.com")).toBeUndefined();
    expect(normalizeDomain("*.")).toBeUndefined();
  });

  test("strings that read as a trusted host but are not", () => {
    // The delimiter cases: each of these contains "github.com" and none of them
    // IS github.com. An operator skimming an approval message sees the tail.
    expect(normalizeDomain("evil.com/#.github.com")).toBeUndefined();
    expect(normalizeDomain("github.com:8443@evil.com")).toBeUndefined();
    expect(normalizeDomain("https://github.com")).toBeUndefined();
    expect(normalizeDomain("github.com/path")).toBeUndefined();
    expect(normalizeDomain("evil.com,github.com")).toBeUndefined();
    expect(normalizeDomain("github.com evil.com")).toBeUndefined();
  });

  test("no-dot and numeric TLDs are refused", () => {
    expect(normalizeDomain("localhost")).toBeUndefined();
    expect(normalizeDomain("127.0.0.1")).toBeUndefined();
    expect(normalizeDomain("")).toBeUndefined();
    expect(normalizeDomain("   ")).toBeUndefined();
  });

  test("malformed labels are refused", () => {
    expect(normalizeDomain("-lead.example.com")).toBeUndefined();
    expect(normalizeDomain("trail-.example.com")).toBeUndefined();
    expect(normalizeDomain("a..example.com")).toBeUndefined();
    expect(normalizeDomain(`${"a".repeat(64)}.example.com`)).toBeUndefined();
  });
});

describe("allowDomain / denyDomain — the list the operator grows", () => {
  test("approving adds, sorted, and is idempotent", () => {
    const one = allowDomain(rec(), "docs.python.org", NOW);
    expect(one.domains).toEqual(["docs.python.org"]);
    const two = allowDomain(one, "api.example.com", NOW);
    expect(two.domains).toEqual(["api.example.com", "docs.python.org"]);
    // Saying yes twice must not grow the file.
    expect(allowDomain(two, "DOCS.python.org", NOW).domains).toEqual(two.domains);
  });

  test("a domain that would not survive validation is refused, not cleaned up", () => {
    expect(() => allowDomain(rec(), "evil.com/#.github.com", NOW)).toThrow(TenantDomainError);
    expect(() => allowDomain(rec(), "*.com", NOW)).toThrow(TenantDomainError);
  });

  test("the cap holds", () => {
    const many = Array.from({ length: MAX_TENANT_DOMAINS }, (_, i) => `h${i}.example.com`);
    const full = rec({ domains: many });
    expect(() => allowDomain(full, "one.more.com", NOW)).toThrow(TenantDomainError);
    // At the cap, re-approving something already present is still fine.
    expect(allowDomain(full, "h0.example.com", NOW).domains).toEqual(many);
  });

  test("revoking removes exactly one and tolerates a miss", () => {
    const t = rec({ domains: ["a.example.com", "b.example.com"] });
    expect(denyDomain(t, "a.example.com").domains).toEqual(["b.example.com"]);
    expect(denyDomain(t, "c.example.com").domains).toEqual(t.domains);
  });
});

describe("policy tier and the egress set", () => {
  test("a record with no policy runs confined — absence never widens", () => {
    expect(policyOf(rec())).toBe("confined");
    expect(policyOf(rec({ policy: "trusted" }))).toBe("trusted");
    expect(setPolicy(rec(), "trusted").policy).toBe("trusted");
  });

  test("egress is the shared toolchain plus this tenant's approvals", () => {
    const d = egressDomainsFor(rec({ domains: ["docs.python.org"] }));
    expect(d).toContain("skills.sh");
    expect(d).toContain("registry.npmjs.org");
    expect(d).toContain("docs.python.org");
    expect(d).toEqual([...d].sort());
    // De-duplicated: approving something already in the base set is not a
    // second entry, or the settings file drifts on every re-provision.
    expect(egressDomainsFor(rec({ domains: ["github.com"] }))).toEqual(egressDomainsFor(rec()));
  });

  test("the WebFetch rule names a host, never a literal wildcard", () => {
    expect(webFetchHost("*.skills.sh")).toBe("skills.sh");
    expect(webFetchHost("github.com")).toBe("github.com");
  });

  test("WebFetch rules are de-duplicated after the wildcard is stripped", () => {
    // The base set carries BOTH `skills.sh` and `*.skills.sh` — two sandbox
    // rules that collapse to one permission rule. Emitted verbatim, the
    // generated settings.json carried `WebFetch(domain:skills.sh)` twice.
    const rules = webFetchRulesFor(rec());
    expect(new Set(rules).size).toBe(rules.length);
    expect(rules.filter((r) => r === "WebFetch(domain:skills.sh)")).toHaveLength(1);
  });
});

describe("normalizeDomain — special-use TLDs never reach the internet (BRO-2245)", () => {
  test("mDNS and other RFC 6761 names are refused", () => {
    // `service.local` is mDNS: approving it puts LAN services on the tenant's egress
    // allowlist. That is a confinement break, not a web grant — the tenant sandbox
    // exists to keep it off the operator's network as much as off their disk.
    for (const d of [
      "service.local",
      "printer.local",
      "foo.localhost",
      "bar.test",
      "x.invalid",
      "y.example",
      "abc.onion",
      "*.local",
    ]) {
      expect(normalizeDomain(d)).toBeUndefined();
    }
  });

  test("POSITIVE CONTROL — ordinary domains, including wildcards, still normalize", () => {
    // Without this, rejecting everything would satisfy the test above.
    expect(normalizeDomain("github.com")).toBe("github.com");
    expect(normalizeDomain("*.github.com")).toBe("*.github.com");
    expect(normalizeDomain("  API.GitHub.CoM ")).toBe("api.github.com");
    // And a domain that merely CONTAINS a reserved label is fine — only the TLD counts.
    expect(normalizeDomain("local.github.com")).toBe("local.github.com");
    expect(normalizeDomain("test.example.com")).toBe("test.example.com");
  });
});

describe("normalizeDomain — the public suffix list, as a dependency (BRO-2245)", () => {
  test("a wildcard over a public suffix is refused — the whole registry in one yes", () => {
    // The finding: `*.co.uk` has two labels after the wildcard, so the old
    // label-counting rule accepted it and one approval opened every .co.uk there is.
    for (const d of ["*.co.uk", "*.com.au", "*.co.jp", "*.org.uk", "*.com.br"]) {
      expect(normalizeDomain(d)).toBeUndefined();
    }
  });

  test("a BARE public suffix is refused too — it is not a host anyone means", () => {
    // Same predicate, and the reason it is one rule rather than two: `co.uk` alone
    // was previously accepted as an exact host.
    expect(normalizeDomain("co.uk")).toBeUndefined();
    expect(normalizeDomain("com.au")).toBeUndefined();
  });

  test("POSITIVE CONTROLS — a real domain under a multi-label suffix still works", () => {
    // Without these, rejecting anything with a two-label tail would pass the tests
    // above while breaking every legitimate UK or Australian domain.
    expect(normalizeDomain("bbc.co.uk")).toBe("bbc.co.uk");
    expect(normalizeDomain("*.bbc.co.uk")).toBe("*.bbc.co.uk");
    expect(normalizeDomain("csiro.com.au")).toBe("csiro.com.au");
    expect(normalizeDomain("github.com")).toBe("github.com");
    expect(normalizeDomain("*.github.com")).toBe("*.github.com");
  });
});
