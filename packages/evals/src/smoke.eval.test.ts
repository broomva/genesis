import { describe, expect, test } from "bun:test";
import { runEvalCase, runEvals } from "./harness";
import { smokeEvals } from "./smoke.eval";

describe("genesis smoke evals (scripted, CI gate)", () => {
  test("the whole suite passes", async () => {
    const results = await runEvals(smokeEvals);
    // Surface every failure name+error in one assertion for a readable CI diff.
    expect(results.filter((r) => !r.pass).map((f) => `${f.name}: ${f.error}`)).toEqual([]);
  });

  // Granular per-case reporting so a CI failure points at the exact scenario.
  for (const c of smokeEvals) {
    test(`eval: ${c.name}`, async () => {
      const r = await runEvalCase(c);
      if (!r.pass) throw new Error(r.error);
      expect(r.pass).toBe(true);
    });
  }
});
