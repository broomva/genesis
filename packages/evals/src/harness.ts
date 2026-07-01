// Typed smoke-eval harness (BRO-1532, item #5 of BRO-1527).
//
// An eval is a scenario: a prompt dispatched through a real Supervisor, with a
// declarative assertion over the projected outcome (phase + reply + the resume
// id passed to the runner). Two run modes share the SAME case definitions:
//
//   - SCRIPTED (default, CI): a deterministic runner returns the case's scripted
//     RunResult — no network, no claude, no flakiness. This is what `bun test`
//     gates on (see *.eval.test.ts). It exercises Supervisor wiring + projection
//     contracts, expressed as scenarios rather than white-box unit tests.
//   - LIVE (`bun run eval --live`): the case's prompt is sent to the REAL agent
//     via runAgent on a LocalHost. Non-deterministic; used as a manual P11
//     interaction check, never in CI.
//
// This mirrors Vercel eve's `.eval.ts` "scored evals wired into CI" — typed,
// declarative, repeatable.

import { type RunnerFn, Supervisor } from "@genesis/core";
import type { RunPhase } from "@genesis/projection";
import { type RunOptions, type RunResult, runAgent } from "@genesis/runner";

/** What an assertion can inspect about a dispatched turn. */
export interface EvalOutcome {
  reply: string;
  phase: RunPhase;
  /** The resume id the runner was invoked with (undefined on a fresh session). */
  resumeSessionId?: string;
}

/** The scripted agent behavior for a deterministic (CI) run. */
export interface EvalScript {
  reply: string;
  sessionId?: string;
  phase?: RunPhase;
  exitCode?: number;
}

export interface EvalCase {
  name: string;
  /** One or more prompts dispatched in order on the same thread (multi-turn). */
  readonly turns: readonly EvalTurn[];
  /** Assertion over the LAST turn's outcome (and all turns). Throws to fail. */
  expect: (last: EvalOutcome, all: EvalOutcome[]) => void;
}

export interface EvalTurn {
  prompt: string;
  /** Scripted result for this turn (CI mode). Ignored in live mode. */
  script: EvalScript;
}

export function defineEval(c: EvalCase): EvalCase {
  return c;
}

export interface EvalResult {
  name: string;
  pass: boolean;
  error?: string;
  outcomes: EvalOutcome[];
}

/** A deterministic runner that replays a queue of scripted results, capturing
 *  the resume id each turn was invoked with. */
function scriptedRunner(scripts: readonly EvalScript[]): {
  run: RunnerFn;
  resumeIds: (string | undefined)[];
} {
  const resumeIds: (string | undefined)[] = [];
  let i = 0;
  const run: RunnerFn = async (opts: RunOptions): Promise<RunResult> => {
    resumeIds.push(opts.resumeSessionId);
    const s = scripts[i++];
    if (!s) throw new Error(`scriptedRunner: no script for turn ${i - 1}`);
    return {
      state: {
        phase: s.phase ?? "done",
        sessionId: s.sessionId,
        lastText: s.reply,
        turns: 1,
      },
      events: [],
      exitCode: s.exitCode ?? 0,
    };
  };
  return { run, resumeIds };
}

const WORKSPACE = { id: "eval-ws", name: "eval", rootPath: "/tmp/genesis-eval" };

/** Run one eval case end-to-end through a real Supervisor. */
export async function runEvalCase(
  c: EvalCase,
  opts: { live?: boolean; workspaceRoot?: string } = {},
): Promise<EvalResult> {
  const thread = `eval-${c.name.replace(/\W+/g, "-")}`;
  const outcomes: EvalOutcome[] = [];
  try {
    // Live mode dispatches the REAL agent, which can mutate the filesystem.
    // Refuse to run it against an implicit cwd (a footgun: an eval prompt could
    // edit the working checkout). Require an explicit, ideally throwaway, dir.
    if (opts.live && !opts.workspaceRoot) {
      throw new Error(
        "live evals require an explicit workspaceRoot (set GENESIS_EVAL_WORKSPACE) — " +
          "refusing to run the agent against the current directory",
      );
    }
    const scripts = c.turns.map((t) => t.script);
    const scripted = scriptedRunner(scripts);
    // Live → the real agent (LocalHost runAgent); scripted → deterministic replay.
    const run: RunnerFn = opts.live ? runAgent : scripted.run;
    const sup = new Supervisor({
      defaultWorkspace: opts.live
        ? { ...WORKSPACE, rootPath: opts.workspaceRoot as string }
        : WORKSPACE,
      run,
      // Scripted evals use a FAKE workspace (WORKSPACE) whose rootPath doesn't
      // exist and a runner that spawns nothing → bypass the BRO-1630 RC3 vanished-
      // cwd guard. Live evals run the real agent against opts.workspaceRoot, which
      // the harness validated exists above, so they keep the real (default) guard.
      workspaceExists: opts.live ? undefined : () => true,
      // Live keeps worktree isolation ON (noWorktree:false) so an eval can't
      // mutate the target checkout's main tree. Scripted never touches the FS
      // (the fake runner spawns nothing), so the flag is irrelevant there.
      noWorktree: false,
    });
    for (let t = 0; t < c.turns.length; t++) {
      const turn = c.turns[t];
      if (!turn) continue;
      const r = await sup.dispatch(thread, turn.prompt);
      outcomes.push({
        reply: r.reply,
        phase: r.phase,
        // Resume id is only observable in scripted mode (we capture what the
        // fake runner was invoked with). In live mode it's undefined, so
        // resume-continuity assertions are SCRIPTED-ONLY by construction.
        resumeSessionId: opts.live ? undefined : scripted.resumeIds[t],
      });
    }
    const last = outcomes[outcomes.length - 1];
    if (!last) throw new Error("eval produced no outcomes");
    c.expect(last, outcomes); // throws on failure
    return { name: c.name, pass: true, outcomes };
  } catch (e) {
    return {
      name: c.name,
      pass: false,
      error: e instanceof Error ? e.message : String(e),
      outcomes,
    };
  }
}

/** Run a suite; returns per-case results (scored). */
export async function runEvals(
  cases: readonly EvalCase[],
  opts: { live?: boolean; workspaceRoot?: string } = {},
): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  for (const c of cases) out.push(await runEvalCase(c, opts));
  return out;
}
