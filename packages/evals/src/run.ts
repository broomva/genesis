#!/usr/bin/env bun
// Eval CLI (BRO-1532). Runs the smoke suite and prints a scored report.
//   bun run eval            # scripted, deterministic (same as the CI gate)
//   bun run eval --live     # dispatch the prompts to the REAL agent (LocalHost)
//                           # in GENESIS_EVAL_WORKSPACE (required); worktree-
//                           # isolated; non-deterministic, P11.
import { runEvals } from "./harness";
import { smokeEvals } from "./smoke.eval";

const live = process.argv.includes("--live");
const results = await runEvals(smokeEvals, {
  live,
  // A DEDICATED eval workspace, never the live GENESIS_WORKSPACE — keeps eval
  // runs off the real working tree. Required for --live (harness throws if unset).
  workspaceRoot: process.env.GENESIS_EVAL_WORKSPACE,
});

let failed = 0;
for (const r of results) {
  console.log(`${r.pass ? "✓" : "✗"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
  if (!r.pass) failed++;
}
console.log(
  `\n${results.length - failed}/${results.length} passed (${live ? "live" : "scripted"})`,
);
process.exit(failed > 0 ? 1 : 0);
