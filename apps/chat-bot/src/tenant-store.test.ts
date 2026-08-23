import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TenantStore, isSafeTenantId, parseRecord } from "./tenant-store";
import type { TenantRecord } from "./tenants";

const dir = () => mkdtempSync(join(tmpdir(), "tenants-"));
const rec = (over: Partial<TenantRecord> = {}): TenantRecord => ({
  id: "573001234567",
  channel: "kapso",
  state: "pending",
  requestedAt: "2026-08-23T02:00:00.000Z",
  ...over,
});

describe("isSafeTenantId — the id is a FILENAME", () => {
  test("accepts digit ids", () => {
    expect(isSafeTenantId("573001234567")).toBe(true);
  });

  test("REJECTS traversal and separators rather than sanitizing them", () => {
    // Sanitizing would turn a hostile id into a valid-looking record for some
    // OTHER tenant. Rejection is the only safe response.
    for (const bad of ["../etc", "5730/1234", "..", ".", "", "57300a", "5730 1234", "5730.json"]) {
      expect(isSafeTenantId(bad)).toBe(false);
    }
  });
});

describe("TenantStore", () => {
  test("round-trips a record", () => {
    const s = new TenantStore(dir());
    s.put(rec({ state: "active", approvedAt: "2026-08-23T03:00:00.000Z", note: "wife" }));
    const got = s.get("573001234567");
    expect(got?.state).toBe("active");
    expect(got?.note).toBe("wife");
  });

  test("an absent tenant is undefined, not an error", () => {
    expect(new TenantStore(dir()).get("573009999999")).toBeUndefined();
  });

  test("a junk id LOOKS UP as undefined instead of throwing", () => {
    // get() is on the hot path for every inbound message; a throw here would
    // take the channel down on one malformed thread id.
    expect(new TenantStore(dir()).get("../../etc/passwd")).toBeUndefined();
  });

  test("a junk id cannot be WRITTEN", () => {
    expect(() => new TenantStore(dir()).put(rec({ id: "../evil" }))).toThrow();
  });

  test("a CORRUPT record throws rather than reading as absent", () => {
    // Reading as absent is the dangerous failure: an approved tenant would be
    // re-acknowledged as a brand new requester, and an active tenant would go
    // silently unserved with nothing reporting why.
    const d = dir();
    writeFileSync(join(d, "573001234567.json"), "{not json");
    expect(() => new TenantStore(d).get("573001234567")).toThrow(/unreadable/);
  });

  test("list() SKIPS a corrupt record so one bad file cannot block startup", () => {
    const d = dir();
    const s = new TenantStore(d);
    s.put(rec({ id: "573001234567", state: "active" }));
    writeFileSync(join(d, "573009999999.json"), "{not json");
    expect(s.list().map((t) => t.id)).toEqual(["573001234567"]);
  });

  test("active() returns only active tenants", () => {
    const s = new TenantStore(dir());
    s.put(rec({ id: "111", state: "active" }));
    s.put(rec({ id: "222", state: "pending" }));
    s.put(rec({ id: "333", state: "suspended" }));
    expect(s.active().map((t) => t.id)).toEqual(["111"]);
  });

  test("writes are atomic — no .tmp left behind", () => {
    const d = dir();
    new TenantStore(d).put(rec());
    expect(new TenantStore(d).list()).toHaveLength(1);
  });
});

describe("parseRecord — validation", () => {
  test("an UNKNOWN state is rejected, never defaulted", () => {
    // Defaulting to pending would silently demote an active tenant on a typo;
    // defaulting to active would promote a rejected one.
    expect(() => parseRecord({ ...rec(), state: "aktive" })).toThrow(/bad state/);
  });

  test("rejects a bad channel, id, or missing requestedAt", () => {
    expect(() => parseRecord({ ...rec(), channel: "telegram" })).toThrow();
    expect(() => parseRecord({ ...rec(), id: "../x" })).toThrow();
    const { requestedAt, ...noReq } = rec();
    expect(() => parseRecord(noReq)).toThrow();
  });

  test("rejects non-objects", () => {
    for (const junk of [null, "x", 3, []]) expect(() => parseRecord(junk)).toThrow();
  });
});

describe("policy + domains survive a write/read cycle (BRO-2236's shape)", () => {
  test("a trusted tenant with approved domains reads back trusted, with them", () => {
    const s = new TenantStore(dir());
    s.put(rec({ state: "active", policy: "trusted", domains: ["docs.python.org"] }));
    const back = s.get("573001234567");
    // The regression this guards: BRO-2236's `confined` was absent from the
    // parse, so the store dropped it and the tenant came back UNCONFINED while
    // every log line said the record loaded fine. A boundary field must either
    // round-trip or make the record unreadable — never quietly vanish.
    expect(back?.policy).toBe("trusted");
    expect(back?.domains).toEqual(["docs.python.org"]);
  });

  test("a record written before these fields existed still loads, at the default tier", () => {
    const d = dir();
    writeFileSync(
      join(d, "573001234567.json"),
      JSON.stringify({
        id: "573001234567",
        channel: "kapso",
        state: "active",
        requestedAt: "2026-08-01T00:00:00.000Z",
      }),
    );
    const back = new TenantStore(d).get("573001234567");
    expect(back?.policy).toBeUndefined();
    expect(back?.domains).toBeUndefined();
  });

  test("a hand-edited record with a junk policy is REJECTED, not defaulted", () => {
    // Defaulting would be the dangerous direction in both cases: to "trusted"
    // it promotes, to "confined" it silently demotes a tenant the operator
    // deliberately widened and nobody sees it happen.
    expect(() => parseRecord({ ...rec(), policy: "root" })).toThrow(/bad policy/);
    expect(() => parseRecord({ ...rec(), policy: "" })).toThrow(/bad policy/);
  });

  test("a domain that could not be approved cannot be smuggled in by hand", () => {
    // The write path validates, but the file is editable by root and by hand,
    // so the READ path validates too — otherwise `allowDomain`'s rejection is
    // advisory and `*.com` reaches a live settings file.
    expect(() => parseRecord({ ...rec(), domains: ["*.com"] })).toThrow(/bad domain/);
    expect(() => parseRecord({ ...rec(), domains: ["evil.com/#.github.com"] })).toThrow(
      /bad domain/,
    );
    expect(() => parseRecord({ ...rec(), domains: [42] })).toThrow(/bad domain entry/);
    expect(() => parseRecord({ ...rec(), domains: "github.com" })).toThrow(/bad domains/);
  });

  test("duplicates and ordering are normalized on read", () => {
    const back = parseRecord({
      ...rec(),
      domains: ["b.example.com", "A.example.com", "b.example.com"],
    });
    expect(back.domains).toEqual(["a.example.com", "b.example.com"]);
  });
});

describe("touchLastSeen — a stale snapshot must not revert a concurrent approval (BRO-2245)", () => {
  test("an approval landing between read and write SURVIVES the stamp", () => {
    const store = new TenantStore(dir());
    store.put({
      id: "573001234567",
      channel: "kapso",
      state: "pending",
      requestedAt: "t0",
    } as never);

    // The bot reads the record at the start of a request...
    const snapshot = store.get("573001234567");
    expect(snapshot?.state).toBe("pending");
    if (snapshot === undefined) throw new Error("unreachable: just written");

    // ...the operator approves via the CLI while that request is in flight...
    store.put({ ...snapshot, state: "active", approvedAt: "t1" } as TenantRecord);

    // ...and the bot then stamps lastSeenAt. The OLD code did
    // `put(snapshot)`, which carried state:"pending" back to disk and silently
    // un-approved the tenant on their very next message.
    store.touchLastSeen("573001234567", "t2");

    const after = store.get("573001234567");
    expect(after?.state).toBe("active"); // the approval survived
    expect(after?.approvedAt).toBe("t1");
    expect(after?.lastSeenAt).toBe("t2"); // and the stamp still landed
  });

  test("POSITIVE CONTROL — it does not resurrect a record that is gone", () => {
    // Without this, a touchLastSeen that blindly wrote `{id, lastSeenAt}` would pass
    // the test above while re-creating tenants the operator had deleted.
    const store = new TenantStore(dir());
    store.touchLastSeen("999", "t2");
    expect(store.get("999")).toBeUndefined();
  });
});
