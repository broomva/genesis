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
    const p = {
      model: "opus",
      effort: "high",
      codexEffort: "minimal",
      theme: "dark",
      showReasoning: false,
      engine: "print",
    };
    expect(sanitizePreferences(p)).toEqual(p);
  });

  test("codexEffort is a separate slot — a codex value survives reload (BRO-1623)", () => {
    // codex-only "minimal" must round-trip (it's invalid for claude but valid for
    // codex); the shared-slot clobber is gone because effort/codexEffort are split.
    const out = sanitizePreferences({ effort: "max", codexEffort: "minimal" });
    expect(out.effort).toBe("max"); // claude pick preserved
    expect(out.codexEffort).toBe("minimal"); // codex pick preserved, independently
    // a missing codexEffort defaults (doesn't borrow `effort`)
    expect(sanitizePreferences({ effort: "high" }).codexEffort).toBe(
      DEFAULT_PREFERENCES.codexEffort,
    );
    // a junk codexEffort falls back
    expect(sanitizePreferences({ codexEffort: "ultra" }).codexEffort).toBe(
      DEFAULT_PREFERENCES.codexEffort,
    );
  });

  test("unknown engine falls back to default; known engine kept (BRO-1620)", () => {
    expect(sanitizePreferences({ engine: "quantum" }).engine).toBe(DEFAULT_PREFERENCES.engine);
    expect(sanitizePreferences({ engine: "print" }).engine).toBe("print");
    expect(sanitizePreferences({ engine: "interactive" }).engine).toBe("interactive");
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
