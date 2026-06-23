import { describe, expect, test } from "bun:test";
import { parseAllowlist, startupGate } from "./allowlist";

describe("parseAllowlist", () => {
  test("unset/empty → open (allow all, sandbox posture)", () => {
    for (const raw of [undefined, "", "   ", ",, ,"]) {
      const a = parseAllowlist(raw);
      expect(a.open).toBe(true);
      expect(a.allows("telegram:anything")).toBe(true);
    }
  });

  test("set → enforced; matches full thread id and bare chat id", () => {
    const a = parseAllowlist("547052379");
    expect(a.open).toBe(false);
    expect(a.allows("telegram:547052379")).toBe(true); // bare id matches thread id
    expect(a.allows("547052379")).toBe(true);
    expect(a.allows("telegram:999")).toBe(false);
    expect(a.allows("telegram:5470523790")).toBe(false); // no partial/substring match
  });

  test("full thread id entries also work", () => {
    const a = parseAllowlist("telegram:547052379, telegram:111");
    expect(a.allows("telegram:547052379")).toBe(true);
    expect(a.allows("telegram:111")).toBe(true);
    expect(a.allows("telegram:222")).toBe(false);
  });

  test("whitespace + multiple entries are tolerated", () => {
    const a = parseAllowlist("  547052379 , 111 ");
    expect(a.allows("telegram:547052379")).toBe(true);
    expect(a.allows("telegram:111")).toBe(true);
  });
});

describe("startupGate (fail-closed, BRO-1534)", () => {
  test("empty allowlist + no opt-out → REFUSE to start", () => {
    for (const raw of [undefined, "", "  "]) {
      const d = startupGate(raw, false);
      expect(d.action).toBe("refuse");
      if (d.action === "refuse") expect(d.reason).toMatch(/RCE-by-DM/);
    }
  });

  test("empty allowlist + GENESIS_ALLOW_OPEN=1 → serve OPEN", () => {
    const d = startupGate("", true);
    expect(d.action).toBe("serve");
    if (d.action === "serve") {
      expect(d.open).toBe(true);
      expect(d.allowlist.allows("telegram:anyone")).toBe(true);
    }
  });

  test("configured allowlist → serve ENFORCED (opt-out irrelevant)", () => {
    const d = startupGate("547052379", false);
    expect(d.action).toBe("serve");
    if (d.action === "serve") {
      expect(d.open).toBe(false);
      expect(d.allowlist.allows("telegram:547052379")).toBe(true);
      expect(d.allowlist.allows("telegram:999")).toBe(false);
    }
  });
});
