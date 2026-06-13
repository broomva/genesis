import { describe, expect, test } from "bun:test";
import { parseAllowlist } from "./allowlist";

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
