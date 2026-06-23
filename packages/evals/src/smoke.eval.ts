// Genesis smoke evals (BRO-1532). Scenario-level checks of the dispatch →
// project → reply contract. Run deterministically in CI (scripted) via
// smoke.eval.test.ts, or against the live agent with `bun run eval --live`.

import { defineEval } from "./harness";

export const smokeEvals = [
  defineEval({
    name: "basic turn completes and surfaces the reply",
    turns: [{ prompt: "say hi", script: { reply: "hi", sessionId: "s1", phase: "done" } }],
    expect: (last) => {
      if (last.phase !== "done") throw new Error(`expected done, got ${last.phase}`);
      if (last.reply !== "hi") throw new Error(`expected reply "hi", got ${last.reply}`);
    },
  }),

  defineEval({
    name: "multi-turn resume continuity (2nd turn resumes the claude session)",
    turns: [
      { prompt: "first", script: { reply: "ok", sessionId: "claude-1", phase: "done" } },
      { prompt: "second", script: { reply: "ok2", sessionId: "claude-1", phase: "done" } },
    ],
    expect: (_last, all) => {
      // The first turn established sessionId "claude-1"; the second must resume it.
      if (all[0]?.resumeSessionId !== undefined) {
        throw new Error(`turn 1 should be fresh, resumed ${all[0]?.resumeSessionId}`);
      }
      if (all[1]?.resumeSessionId !== "claude-1") {
        throw new Error(`turn 2 should resume claude-1, got ${all[1]?.resumeSessionId}`);
      }
    },
  }),

  defineEval({
    name: "blocked phase surfaces to the user (not a fake done)",
    turns: [{ prompt: "do something impossible", script: { reply: "couldn't", phase: "blocked" } }],
    expect: (last) => {
      if (last.phase !== "blocked") throw new Error(`expected blocked, got ${last.phase}`);
    },
  }),

  defineEval({
    name: "a long reply is passed through intact (no truncation)",
    turns: [{ prompt: "write a lot", script: { reply: "x".repeat(4096), phase: "done" } }],
    expect: (last) => {
      if (last.reply.length !== 4096) throw new Error(`reply truncated to ${last.reply.length}`);
    },
  }),
];
