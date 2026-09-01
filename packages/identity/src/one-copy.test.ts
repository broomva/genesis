import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * There must be exactly ONE digit-stripping phone normalizer in the repo.
 *
 * There were five, under four names, in four files — and the thing meant to
 * hold them together was a test in voice.test.ts named "DRIFT GUARD" that
 * re-implemented the rule inline instead of importing it. Mutating
 * `normalizePhone` to a completely unrelated rule left it reporting 14 pass /
 * 0 fail (BRO-2422). Consolidation removes the drift class; this keeps it
 * removed, because the next copy was already scheduled — BRO-2389 adds a device
 * principal and its ticket says to write a third — it would have been the sixth.
 *
 * Two design notes, both learned from a gate that had to be rewritten four times:
 *
 *   The needle is ASSEMBLED, never written literally, or this file matches
 *   itself and the gate is unfalsifiable.
 *
 *   The scan is DERIVED from `git ls-files`, not a hand-maintained path list. A
 *   hand-maintained scope is a hole that widens by omission — a new app would
 *   simply not be looked at.
 */
const ROOT = resolve(import.meta.dir, "../../..");

// Assembled so this file does not contain the literals it searches for.
//
// More than one spelling, because the first version scanned for exactly one and
// a review demonstrated the negated-character-class form walking straight past
// it. Spelling that form out in this comment is what made the scan match its own
// prose on the next run — hence the assembly, and hence no literal here. This is
// not a claim to catch every rewrite; it catches the forms people actually
// write.
const NEEDLES = [
  ["replace(/", "\\", "D/g"].join(""),
  // PREFIX, stopping at the digit range rather than closing the character class.
  // The closed form missed any class that keeps an extra character alongside the
  // digits — notably the one that preserves a leading plus, which for PHONE
  // numbers is the likeliest thing to write and is what a dogfood plant escaped
  // with. Truncating covers the closed form and every extended one.
  //
  // NO LITERAL EXAMPLES IN THIS COMMENT. The first draft named the escaping form
  // in prose and the scan promptly matched THIS FILE — the exact failure the
  // docblock above warns about, reproduced four lines below the warning.
  ["replace(/[^", "0-9"].join(""),
  ["replace(/[^", "\\", "d]/g"].join(""),
  // `replaceAll` does NOT contain the `replace(` needle as a substring, so it
  // was a working copy the gate walked straight past — while AGENTS.md told the
  // next agent it was covered.
  ["replaceAll(/", "\\", "D/g"].join(""),
];

/** Pinned, because the three needles added after the first were exercised by
 *  nothing: reducing this list back to one left the suite green, so they could
 *  be deleted silently. Same shape as the sweep's EXPECTED_MUTANTS. */
const EXPECTED_NEEDLES = 4;

/** The single legitimate home, relative to the repo root. */
const HOME = "packages/identity/src/index.ts";

function trackedTs(): string[] {
  // Every TypeScript extension, not just `.ts`. The first version scanned `*.ts`
  // while its own docblock said a derived scan has no holes by omission — and it
  // omitted apps/web's 54 tracked `.tsx` files, which is the app that already
  // renders phone requests and is therefore the likeliest home for copy six.
  const out = Bun.spawnSync(
    ["git", "ls-files", "--", "*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"],
    { cwd: ROOT },
  ).stdout.toString();
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

describe("exactly one phone normalizer", () => {
  const files = trackedTs();

  test("every declared needle is still declared", () => {
    // Arity, not content: the offender scan iterates NEEDLES, so any test written
    // over NEEDLES passes trivially after one is deleted. Only a count declared
    // separately notices.
    expect(NEEDLES.length).toBe(EXPECTED_NEEDLES);
    expect(new Set(NEEDLES).size).toBe(EXPECTED_NEEDLES);
  });

  test("the scan sees a real, non-trivial set of files", () => {
    // Without this the two assertions below pass vacuously the moment
    // `git ls-files` returns nothing (wrong cwd, no git, renamed package).
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(HOME);
  });

  test("the scan reaches apps/web, the likeliest home for the next copy", () => {
    // Named explicitly because this is the hole the first version had: `*.ts`
    // alone could not see a `.tsx` file.
    expect(files.some((f) => f.startsWith("apps/web/") && f.endsWith(".tsx"))).toBe(true);
  });

  test("POSITIVE CONTROL: the scan finds the implementation where it lives", () => {
    // If this fails, the needle no longer matches the real code and the
    // assertion below is proving nothing.
    const home = readFileSync(`${ROOT}/${HOME}`, "utf8");
    expect(NEEDLES.some((n) => home.includes(n))).toBe(true);
  });

  test("no other file carries a second copy", () => {
    const offenders = files
      .filter((f) => f !== HOME)
      .filter((f) => {
        try {
          const body = readFileSync(`${ROOT}/${f}`, "utf8");
          return NEEDLES.some((n) => body.includes(n));
        } catch {
          return false;
        }
      });
    expect(offenders).toEqual([]);
  });
});
