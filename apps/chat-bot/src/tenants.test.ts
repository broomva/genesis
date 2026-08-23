import { describe, expect, test } from "bun:test";
import { type TenantRecord, admit, approve, pruneTimestamps, rateLimit, suspend } from "./tenants";

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

  test("max <= 0 blocks everything rather than dividing by zero", () => {
    expect(rateLimit([], 1000, WINDOW, 0).allowed).toBe(false);
  });

  test("pruneTimestamps keeps only the window", () => {
    expect(pruneTimestamps([1, 2, 59_000, 59_999], 60_000, WINDOW)).toEqual([1, 2, 59_000, 59_999]);
    expect(pruneTimestamps([1, 2, 59_000], 120_000, WINDOW)).toEqual([]);
  });
});
