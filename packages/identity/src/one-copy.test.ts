import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * There must be exactly ONE digit-stripping phone normalizer in the repo.
 *
 * There were four, under four names, in three files — and the thing meant to
 * hold them together was a test in voice.test.ts named "DRIFT GUARD" that
 * re-implemented the rule inline instead of importing it. Mutating
 * `normalizePhone` to a completely unrelated rule left it reporting 14 pass /
 * 0 fail (BRO-2422). Consolidation removes the drift class; this keeps it
 * removed, because the next copy was already scheduled — BRO-2389 adds a device
 * principal and its ticket says to write a third (in fact fifth) one.
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

// Assembled so this file does not contain the literal it searches for.
const NEEDLE = ["replace(/", "\\", "D/g"].join("");

/** The single legitimate home, relative to the repo root. */
const HOME = "packages/identity/src/index.ts";

function trackedTs(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "--", "*.ts"], { cwd: ROOT }).stdout.toString();
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

describe("exactly one phone normalizer", () => {
  const files = trackedTs();

  test("the scan sees a real, non-trivial set of files", () => {
    // Without this the two assertions below pass vacuously the moment
    // `git ls-files` returns nothing (wrong cwd, no git, renamed package).
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(HOME);
  });

  test("POSITIVE CONTROL: the scan finds the implementation where it lives", () => {
    // If this fails, the needle no longer matches the real code and the
    // assertion below is proving nothing.
    expect(readFileSync(`${ROOT}/${HOME}`, "utf8")).toContain(NEEDLE);
  });

  test("no other file carries a second copy", () => {
    const offenders = files
      .filter((f) => f !== HOME)
      .filter((f) => {
        try {
          return readFileSync(`${ROOT}/${f}`, "utf8").includes(NEEDLE);
        } catch {
          return false;
        }
      });
    expect(offenders).toEqual([]);
  });
});
