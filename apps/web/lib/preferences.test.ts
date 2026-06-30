import { describe, expect, test } from "bun:test";

import { DEFAULT_PREFERENCES, isKnownTheme, sanitizePreferences } from "./preferences";

describe("sanitizePreferences (BRO-1618)", () => {
  test("empty / non-object input → defaults", () => {
    expect(sanitizePreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(sanitizePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(sanitizePreferences("nope")).toEqual(DEFAULT_PREFERENCES);
    expect(sanitizePreferences({})).toEqual(DEFAULT_PREFERENCES);
  });

  test("valid full shape is preserved", () => {
    const p = { model: "opus", effort: "high", theme: "dark", showReasoning: false };
    expect(sanitizePreferences(p)).toEqual(p);
  });

  test("unknown / stale model + effort fall back (never leave a Select blank)", () => {
    const out = sanitizePreferences({ model: "gpt-9", effort: "ultra", theme: "system" });
    expect(out.model).toBe(DEFAULT_PREFERENCES.model);
    expect(out.effort).toBe(DEFAULT_PREFERENCES.effort);
    expect(out.theme).toBe("system");
  });

  test("invalid theme → default; showReasoning coerces only real booleans", () => {
    expect(sanitizePreferences({ theme: "neon" }).theme).toBe(DEFAULT_PREFERENCES.theme);
    expect(sanitizePreferences({ showReasoning: "true" }).showReasoning).toBe(true); // non-bool → default true
    expect(sanitizePreferences({ showReasoning: false }).showReasoning).toBe(false);
  });

  test("partial merge keeps the rest at defaults", () => {
    const out = sanitizePreferences({ theme: "dark" });
    expect(out).toEqual({ ...DEFAULT_PREFERENCES, theme: "dark" });
  });

  test("isKnownTheme guards the three values", () => {
    expect(isKnownTheme("light")).toBe(true);
    expect(isKnownTheme("dark")).toBe(true);
    expect(isKnownTheme("system")).toBe(true);
    expect(isKnownTheme("sepia")).toBe(false);
    expect(isKnownTheme(null)).toBe(false);
  });
});
