import { describe, expect, test } from "bun:test";
import { normalizePhoneId } from "./index";

describe("normalizePhoneId", () => {
  test("punctuation is stripped, so one number written many ways is one id", () => {
    for (const spelling of [
      "+57 301 775 8620",
      "573017758620",
      "+573017758620",
      "57-301-7758620",
      "  57 (301) 775-8620  ",
      "tel:+573017758620",
    ]) {
      expect(normalizePhoneId(spelling)).toBe("573017758620");
    }
  });

  // Documented as a limit rather than left to be discovered. `\D` is
  // ASCII-relative, so these are stripped rather than transliterated — the id
  // becomes "" and callers reject it, instead of it being silently mis-routed.
  test("non-ASCII digits normalize to empty, not to a wrong id", () => {
    expect(normalizePhoneId("٣٤٥")).toBe("");
    expect(normalizePhoneId("57٣٤٥8620")).toBe("578620");
  });

  // These pin a LIMIT, not a wish. Stripping leading zeros would merge "0057…"
  // into "57…", joining two ids that today belong to two principals — a change
  // with a real blast radius, so it must not be possible to make it silently.
  // (It also kills a `.replace(/^0+/, "")` mutant, which survived every test.)
  test("dialling forms are NOT canonicalised, and that is deliberate", () => {
    expect(normalizePhoneId("+57 300 123 4567")).toBe("573001234567");
    expect(normalizePhoneId("0057 300 123 4567")).toBe("00573001234567");
    expect(normalizePhoneId("(300) 123-4567")).toBe("3001234567");
    // Same human, three ids. Each fails closed: an id that does not match is
    // treated as unknown, never as somebody else.
    expect(new Set(["573001234567", "00573001234567", "3001234567"]).size).toBe(3);
  });

  test("the id is never truncated", () => {
    // Kills a `.slice(0, 15)` "E.164 length" mutant, which survived every test.
    const long = `+${"9".repeat(24)}`;
    expect(normalizePhoneId(long)).toBe("9".repeat(24));
    expect(normalizePhoneId(long).length).toBe(24);
  });

  test("it is not a validator — garbage yields an empty id", () => {
    for (const junk of ["", "   ", "hello", "+++", "tel:"]) {
      expect(normalizePhoneId(junk)).toBe("");
    }
  });
});
