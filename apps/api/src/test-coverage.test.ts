// `bun run test` must actually run the tests. It did not. (BRO-2407.)
//
// MEASURED. `bun test` from the repo root discovers 89 test files; `turbo run
// test` ran 9 package tasks, 8 of them CACHED. The difference is not a rounding
// error and not academic: `apps/api` and `apps/web` defined no `test` script, so
// turbo never ran their 30 test files — which is every walkie test in this repo,
// including the ask log, the walkie routes and the entrypoint wiring.
//
// Two failure modes compounding: a developer running the documented command
// (`bun run test`, what package.json defines) saw nine green tasks and had run
// none of the API tests; and turbo caches, so that command can report success
// having executed nothing at all.
//
// CI runs bare `bun test` — bun's own root discovery — which is the superset and
// the right choice, not least because scripts/*.test.ts sits outside every
// workspace and no per-package task can ever reach it. This file keeps the two
// from diverging again.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..");

/** Every *.test.ts tracked in the repo, excluding vendored and worktree copies. */
function testFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git" || e === ".worktrees" || e === ".next") continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) testFiles(full, acc);
    else if (e.endsWith(".test.ts")) acc.push(full.slice(ROOT.length + 1));
  }
  return acc;
}

const FILES = testFiles(ROOT);

describe("the documented test command runs the tests", () => {
  test("there are test files to reason about", () => {
    // Arity. Without it, an empty result set makes every assertion below vacuous.
    expect(FILES.length).toBeGreaterThan(50);
  });

  test("every workspace package containing tests defines a `test` script", () => {
    // The assertion that would have caught this. apps/api held 15 test files and
    // no way for turbo to run them.
    const offenders: string[] = [];
    for (const area of ["apps", "packages"]) {
      for (const name of readdirSync(join(ROOT, area))) {
        const pkgDir = join(area, name);
        const manifest = join(ROOT, pkgDir, "package.json");
        let scripts: Record<string, string> = {};
        try {
          scripts = JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {};
        } catch {
          continue; // not a package
        }
        const hasTests = FILES.some((f) => f.startsWith(`${pkgDir}/`));
        if (hasTests && !scripts.test) offenders.push(pkgDir);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("tests outside every workspace exist, which is why CI runs root discovery", () => {
    // scripts/*.test.ts is in no workspace, so `turbo run test` can never reach
    // it however many package scripts are added. This is the positive reason CI
    // runs bare `bun test` rather than `bun run test`, and it stops the next
    // person "simplifying" CI to the turbo task.
    expect(FILES.filter((f) => f.startsWith("scripts/")).length).toBeGreaterThan(0);
  });

  test("the CI test job runs bare `bun test`, not the turbo task", () => {
    const wf = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(wf).toMatch(/^\s+- run: bun test$/m);
    expect(wf).not.toMatch(/^\s+- run: bun run test$/m);
  });

  test("every workspace package with TypeScript defines a `typecheck` script", () => {
    // THE SIBLING GUARD, added after making the same mistake one command over.
    //
    // I found that `bun run test` skipped 30 files because two packages had no
    // `test` script, fixed it, added the assertion above — and then verified this
    // very change with `tsc --noEmit -p apps/api/tsconfig.json` while CI runs
    // `turbo run typecheck` over ELEVEN packages. Two real type errors in
    // packages/projection passed my local gate and failed CI.
    //
    // The instance was my habit; the class is a package that turbo would silently
    // skip. This is the part that can be asserted.
    const offenders: string[] = [];
    for (const area of ["apps", "packages"]) {
      for (const name of readdirSync(join(ROOT, area))) {
        const pkgDir = join(area, name);
        let scripts: Record<string, string> = {};
        try {
          scripts =
            JSON.parse(readFileSync(join(ROOT, pkgDir, "package.json"), "utf8")).scripts ?? {};
        } catch {
          continue;
        }
        const hasTs = existsSync(join(ROOT, pkgDir, "tsconfig.json"));
        if (hasTs && !scripts.typecheck) offenders.push(pkgDir);
      }
    }
    expect(offenders).toEqual([]);
  });
});
