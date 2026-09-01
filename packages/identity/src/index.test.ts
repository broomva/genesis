import { describe, expect, test } from "bun:test";
import { normalizePhoneId } from "./index";

describe("normalizePhoneId", () => {
  test("reduces every spelling of one number to one id", () => {
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

  test("it is not a validator — garbage yields an empty id", () => {
    for (const junk of ["", "   ", "hello", "+++", "tel:"]) {
      expect(normalizePhoneId(junk)).toBe("");
    }
  });
});
