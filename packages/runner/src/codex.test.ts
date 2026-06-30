// Codex engine tests (BRO-1621). The make-or-break piece is the same as for
// claude: the translation from the CLI's native JSONL into the Genesis
// AgentEvent stream the reducer folds. We pin it against the REAL codex
// `exec --json` lines captured from an authed run (a trivial answer and a shell
// command), plus targeted units for usage mapping, reasoning, errors, argv, and
// a runCodex integration over a scripted host.

import { describe, expect, test } from "bun:test";
import type { ExecOpts, ExecResult, ExecutionHost, SpawnHandle } from "@genesis/host";
import { reduceAll } from "@genesis/projection";
import { codexArgs, parseCodexLine, parseCodexStream, runCodex } from "./codex";

// ── Real captured fixtures (golden) ─────────────────────────────────────────
// "what is 2+2" — a one-word answer, no tools, no reasoning item.
const FIXTURE_ANSWER = [
  '{"type":"thread.started","thread_id":"019f1964-e58f-7853-9cef-5f3dfae6caf5"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Four"}}',
  '{"type":"turn.completed","usage":{"input_tokens":20498,"cached_input_tokens":2432,"output_tokens":17,"reasoning_output_tokens":10}}',
].join("\n");

// "run echo hello-codex" — a command_execution item (started → completed) then
// the agent_message summarizing it.
const FIXTURE_SHELL = [
  '{"type":"thread.started","thread_id":"019f1965-8f64-7262-98c2-f270e775ef64"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc \'echo hello-codex\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc \'echo hello-codex\'","aggregated_output":"hello-codex\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"output:\\n\\nhello-codex"}}',
  '{"type":"turn.completed","usage":{"input_tokens":41324,"cached_input_tokens":22272,"output_tokens":58,"reasoning_output_tokens":0}}',
].join("\n");

describe("parseCodexStream + reduceAll — golden fixtures", () => {
  test("trivial answer folds to a done state with text, session id, and usage", () => {
    const state = reduceAll(parseCodexStream(FIXTURE_ANSWER));
    expect(state.phase).toBe("done");
    expect(state.sessionId).toBe("019f1964-e58f-7853-9cef-5f3dfae6caf5");
    expect(state.lastText).toBe("Four");
    // input EXCLUDES cache (20498 total − 2432 cached); cacheRead = cached.
    expect(state.usage).toEqual({
      input: 18066,
      output: 17,
      cacheRead: 2432,
      cacheCreation: 0,
    });
    // costUsd is unknown for codex (the CLI doesn't price the turn).
    expect(state.costUsd).toBeUndefined();
    const parts = state.parts ?? [];
    expect(parts).toEqual([{ type: "text", text: "Four" }]);
  });

  test("shell command folds to an output-available tool part then the answer text", () => {
    const state = reduceAll(parseCodexStream(FIXTURE_SHELL));
    expect(state.phase).toBe("done");
    expect(state.sessionId).toBe("019f1965-8f64-7262-98c2-f270e775ef64");
    expect(state.lastText).toBe("output:\n\nhello-codex");
    expect(state.usage).toEqual({
      input: 19052,
      output: 58,
      cacheRead: 22272,
      cacheCreation: 0,
    });
    const parts = state.parts ?? [];
    expect(parts).toHaveLength(2);
    const tool = parts[0];
    expect(tool).toMatchObject({
      type: "tool",
      toolCallId: "item_0",
      toolName: "shell",
      input: { command: "/bin/zsh -lc 'echo hello-codex'" },
      output: "hello-codex\n",
      state: "output-available",
    });
    expect(parts[1]).toEqual({ type: "text", text: "output:\n\nhello-codex" });
  });
});

describe("parseCodexLine — units", () => {
  test("thread.started → system event capturing the session id", () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"abc"}')).toEqual([
      { type: "system", subtype: "init", session_id: "abc" },
    ]);
  });

  test("turn.started yields nothing (the system event already started the run)", () => {
    expect(parseCodexLine('{"type":"turn.started"}')).toEqual([]);
  });

  test("agent_message item.completed → assistant text", () => {
    const events = parseCodexLine(
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"hello"}}',
    );
    expect(events).toEqual([
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      },
    ]);
  });

  test("agent_message item.started yields nothing (only completed carries text)", () => {
    expect(
      parseCodexLine('{"type":"item.started","item":{"id":"i1","type":"agent_message","text":""}}'),
    ).toEqual([]);
  });

  test("command_execution completed → idempotent tool_use + tool_result, exit 0 = ok", () => {
    const events = parseCodexLine(
      '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"ls","aggregated_output":"a\\nb\\n","exit_code":0}}',
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "shell", input: { command: "ls" } }],
      },
    });
    expect(events[1]).toMatchObject({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "c1", content: "a\nb\n", is_error: false }],
      },
    });
  });

  test("command_execution non-zero exit → tool_result is_error true", () => {
    const events = parseCodexLine(
      '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"false","aggregated_output":"","exit_code":1}}',
    );
    expect(events[1]).toMatchObject({
      message: { content: [{ type: "tool_result", is_error: true }] },
    });
  });

  test("command_execution started → tool_use only (input-available)", () => {
    const events = parseCodexLine(
      '{"type":"item.started","item":{"id":"c1","type":"command_execution","command":"sleep 1","exit_code":null,"status":"in_progress"}}',
    );
    expect(events).toEqual([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "c1", name: "shell", input: { command: "sleep 1" } }],
        },
      },
    ]);
  });

  test("reasoning item.completed → thinking block (reasoned, prose from text)", () => {
    const state = reduceAll(
      parseCodexLine(
        '{"type":"item.completed","item":{"id":"r1","type":"reasoning","text":"let me think"}}',
      ),
    );
    expect(state.reasoned).toBe(true);
    expect(state.reasoning).toBe("let me think");
  });

  test("reasoning with a summary array joins the fragments", () => {
    const state = reduceAll(
      parseCodexLine(
        '{"type":"item.completed","item":{"id":"r1","type":"reasoning","summary":["plan ",{"text":"step"}]}}',
      ),
    );
    expect(state.reasoned).toBe(true);
    expect(state.reasoning).toBe("plan step");
  });

  test("an unknown item type still surfaces as a generic tool part on completion", () => {
    const state = reduceAll(
      parseCodexLine(
        '{"type":"item.completed","item":{"id":"f1","type":"file_change","changes":[{"path":"x.ts"}]}}',
      ),
    );
    const tool = (state.parts ?? [])[0];
    expect(tool).toMatchObject({
      type: "tool",
      toolCallId: "f1",
      toolName: "file_change",
      state: "output-available",
    });
  });

  test("turn.completed → success result with mapped usage", () => {
    expect(
      parseCodexLine(
        '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2}}',
      ),
    ).toEqual([
      {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 6,
          output_tokens: 2,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 0,
        },
      },
    ]);
  });

  test("turn.failed → errored result (folds to blocked)", () => {
    const events = parseCodexLine('{"type":"turn.failed","error":{"message":"rate limited"}}');
    expect(events).toEqual([{ type: "result", is_error: true, subtype: "rate limited" }]);
    expect(reduceAll(events).phase).toBe("blocked");
  });

  test("top-level error line → errored result", () => {
    expect(parseCodexLine('{"type":"error","message":"boom"}')).toEqual([
      { type: "result", is_error: true, subtype: "boom" },
    ]);
  });

  test("blank, malformed, and unknown lines are skipped", () => {
    expect(parseCodexLine("")).toEqual([]);
    expect(parseCodexLine("   ")).toEqual([]);
    expect(parseCodexLine("not json")).toEqual([]);
    expect(parseCodexLine('{"type":"thread.metadata","foo":1}')).toEqual([]);
    expect(parseCodexLine("[1,2,3]")).toEqual([]);
  });
});

describe("codexArgs", () => {
  test("new turn: exec --json, sandbox flag + approval via -c, prompt after --", () => {
    expect(codexArgs({ prompt: "do it", cwd: "/repo" })).toEqual([
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-s",
      "workspace-write",
      "-c",
      "approval_policy=never",
      "--",
      "do it",
    ]);
  });

  test("resume: exec resume <id> with -c overrides (no -s flag on resume)", () => {
    expect(codexArgs({ prompt: "more", cwd: "/repo", resumeSessionId: "tid-9" })).toEqual([
      "codex",
      "exec",
      "resume",
      "tid-9",
      "--json",
      "--skip-git-repo-check",
      "-c",
      "sandbox_mode=workspace-write",
      "-c",
      "approval_policy=never",
      "--",
      "more",
    ]);
  });

  test("a prompt starting with a dash can't be parsed as a flag (after --)", () => {
    const args = codexArgs({ prompt: "--help me", cwd: "/repo" });
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("--help me");
  });
});

// ── runCodex integration over a scripted host ───────────────────────────────
function streamOf(lines: string[]): SpawnHandle {
  async function* gen() {
    for (const l of lines) yield l;
  }
  return { stdout: gen(), exitCode: Promise.resolve(0), kill: () => {} };
}

// microVM host = no worktree / no git probing, so we can drive runCodex with a
// pure scripted stdout and assert the fold + spawned argv.
class FakeMicroVMHost implements ExecutionHost {
  readonly kind = "microvm" as const;
  readonly credentialTier = "keyed" as const;
  spawnCmd?: string[];
  spawnOpts?: ExecOpts;
  constructor(private lines: string[]) {}
  async exec(): Promise<ExecResult> {
    return { code: 0, stdout: "", stderr: "" };
  }
  spawnStream(cmd: string[], opts?: ExecOpts): SpawnHandle {
    this.spawnCmd = cmd;
    this.spawnOpts = opts;
    return streamOf(this.lines);
  }
  async readFile() {
    return "";
  }
  async writeFile() {}
}

describe("runCodex", () => {
  test("folds a codex stream to a done RunResult and scrubs the env", async () => {
    const host = new FakeMicroVMHost(FIXTURE_ANSWER.split("\n"));
    const r = await runCodex({ prompt: "2+2", cwd: "/x", host });
    expect(r.state.phase).toBe("done");
    expect(r.state.lastText).toBe("Four");
    expect(r.exitCode).toBe(0);
    expect(r.worktreePath).toBeUndefined(); // microVM is its own isolation
    // env is REPLACED (scrubbed), not merged.
    expect(host.spawnOpts?.replaceEnv).toBe(true);
    expect(host.spawnCmd?.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
  });

  test("a resumed turn seeds the session id and uses the resume argv", async () => {
    // A resumed run whose stream omits thread.started must still carry the id.
    const host = new FakeMicroVMHost([
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"ok"}}',
      '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":0,"output_tokens":1}}',
    ]);
    const r = await runCodex({ prompt: "again", cwd: "/x", host, resumeSessionId: "tid-42" });
    expect(r.state.sessionId).toBe("tid-42");
    expect(r.state.phase).toBe("done");
    expect(host.spawnCmd?.slice(0, 4)).toEqual(["codex", "exec", "resume", "tid-42"]);
  });

  test("a nonzero exit with no terminal result surfaces as blocked", async () => {
    const host = new FakeMicroVMHost(['{"type":"thread.started","thread_id":"t"}']);
    // Override the exit code to nonzero with no result line.
    host.spawnStream = (cmd: string[], opts?: ExecOpts) => {
      host.spawnCmd = cmd;
      host.spawnOpts = opts;
      async function* gen() {
        yield '{"type":"thread.started","thread_id":"t"}';
      }
      return { stdout: gen(), exitCode: Promise.resolve(1), kill: () => {} };
    };
    const r = await runCodex({ prompt: "x", cwd: "/x", host });
    expect(r.state.phase).toBe("blocked");
    expect(r.state.error).toContain("codex exited 1");
  });
});
