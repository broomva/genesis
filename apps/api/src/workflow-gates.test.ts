// The required check must cover every job, and the coverage claim about `bun test`
// must be true. Both are properties of files that CI reads and nothing else does,
// so without these they are prose. (BRO-2407.)

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const WORKFLOW = resolve(ROOT, ".github/workflows/ci.yml");

// Bun.YAML rather than an npm dependency — it is in the runtime this repo already
// pins to an exact version.
const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, "utf8")) as {
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    { needs?: string[]; if?: string; steps?: { run?: string; uses?: string }[] }
  >;
};

const AGGREGATE = "gates";

describe("the required check covers every job", () => {
  test("the workflow parses and defines more than one job", () => {
    // The arity guard. Delete every job but the aggregate and the assertions
    // below are all vacuously true.
    expect(Object.keys(workflow.jobs ?? {}).length).toBeGreaterThan(1);
  });

  test(`every job other than \`${AGGREGATE}\` is in \`${AGGREGATE}.needs\``, () => {
    // TWO INDEPENDENT LISTS. This cannot be asserted inside the workflow:
    // `toJSON(needs)` contains exactly the keys in `needs:`, so any count taken
    // from it is that list compared against itself. walkie shipped precisely that
    // check and documented it as catching the drift it was structurally incapable
    // of seeing. The `jobs:` keys and `gates.needs` are not derived from each
    // other, so adding a job without wiring it in makes them disagree.
    const all = Object.keys(workflow.jobs).filter((j) => j !== AGGREGATE);
    const needs = workflow.jobs[AGGREGATE]?.needs ?? [];
    expect([...all].sort()).toEqual([...needs].sort());
  });

  test(`\`${AGGREGATE}\` actually evaluates its dependencies' results`, () => {
    const runs = (workflow.jobs[AGGREGATE]?.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(runs).toContain("scripts/assert-gates-succeeded.sh");
  });

  test(`\`${AGGREGATE}\` runs even when a dependency fails`, () => {
    // Without `!cancelled()` the job is SKIPPED when a dependency fails, and
    // GitHub counts a skipped required check as PASSING — the aggregate would go
    // green precisely when a gate had failed.
    expect(workflow.jobs[AGGREGATE]?.if).toContain("!cancelled()");
  });

  test("the workflow declares least-privilege permissions", () => {
    expect(workflow.permissions?.contents).toBe("read");
  });

  test("every action is pinned to a full commit SHA, not a movable tag", () => {
    // A tag can be moved; a 40-hex SHA cannot. The rest of this pipeline is
    // rigorously pinned — bun to an exact version, deps via --frozen-lockfile —
    // so an unpinned action was the only mutable execution surface left.
    const uses = Object.values(workflow.jobs)
      .flatMap((j) => j.steps ?? [])
      .map((s) => s.uses)
      .filter((u): u is string => typeof u === "string");
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });

  test("every job that installs also asserts the lockfile exists", () => {
    // `--frozen-lockfile` PASSES when there is no lockfile at all, installing
    // from package.json instead. A job that installs without this line has a
    // vacuous install step.
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const runs = (job.steps ?? []).map((s) => s.run ?? "").join("\n");
      if (!runs.includes("bun install --frozen-lockfile")) continue;
      expect(`${name}: ${runs}`).toContain("test -f bun.lock");
    }
  });
});
