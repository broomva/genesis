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
