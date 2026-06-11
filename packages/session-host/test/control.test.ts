// ControlServer contract tests — exercise the unix socket exactly the way the
// curl shim does, with REAL hook payload shapes captured from the 2026-06-11
// probe (v2.1.173).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlServer } from "../src/control";
import type { IREvent } from "../src/ir";

// Verbatim shapes from the live probe (trimmed paths).
const PRETOOL_PAYLOAD = {
  session_id: "e4a96bba-951f-482c-804d-ef64478c82c9",
  transcript_path: "/tmp/x/e4a96bba.jsonl",
  cwd: "/tmp/x",
  permission_mode: "default",
  effort: { level: "high" },
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "echo genesis-probe-ok", description: "Echo test string" },
  tool_use_id: "toolu_01X98xCKtkXjZcSCZv6D23cf",
};

const STOP_PAYLOAD = {
  session_id: "e4a96bba-951f-482c-804d-ef64478c82c9",
  transcript_path: "/tmp/x/e4a96bba.jsonl",
  cwd: "/tmp/x",
  permission_mode: "default",
  hook_event_name: "Stop",
  stop_hook_active: false,
  last_assistant_message: "Output:\n\n```\ngenesis-probe-ok\n```",
  background_tasks: [],
  session_crons: [],
};

let servers: ControlServer[] = [];

function makeServer(
  events: IREvent[],
  policy?: ConstructorParameters<typeof ControlServer>[0]["policy"],
  holdOpenMs?: number,
): { server: ControlServer; sock: string } {
  const sockDir = require("node:fs").mkdtempSync(join(tmpdir(), "gen-ctl-"));
  const sock = join(sockDir, "c.sock");
  const server = new ControlServer({
    socketPath: sock,
    onEvent: (e) => events.push(e),
    policy,
    holdOpenMs,
    timeoutDecision: "ask",
  });
  server.start();
  servers.push(server);
  return { server, sock };
}

async function post(sock: string, route: string, body: unknown): Promise<unknown> {
  const res = await fetch(`http://genesis${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    unix: sock,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

afterEach(() => {
  for (const s of servers) s.stop();
  servers = [];
});

describe("ControlServer", () => {
  test("policy auto-allow returns the documented PreToolUse decision JSON", async () => {
    const events: IREvent[] = [];
    const { sock } = makeServer(events, () => ({ decision: "allow", reason: "echo is safe" }));
    const reply = (await post(sock, "/hook", PRETOOL_PAYLOAD)) as Record<string, any>;
    expect(reply.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(reply.hookSpecificOutput.permissionDecision).toBe("allow");
    const resolved = events.find((e) => e.kind === "permission.resolved");
    expect(resolved?.kind === "permission.resolved" && resolved.source).toBe("policy");
  });

  test("held request resolves when a client responds (the permission card)", async () => {
    const events: IREvent[] = [];
    const { server, sock } = makeServer(events); // no policy → hold open
    const inFlight = post(sock, "/hook", PRETOOL_PAYLOAD);

    // Wait for the permission.request event to surface, then respond.
    while (!events.some((e) => e.kind === "permission.request")) await Bun.sleep(10);
    const request = events.find((e) => e.kind === "permission.request");
    if (request?.kind !== "permission.request") throw new Error("unreachable");
    expect(request.toolName).toBe("Bash");
    expect(server.pendingRequests().length).toBe(1);

    expect(server.respond(request.requestId, "deny", "not today")).toBe(true);
    const reply = (await inFlight) as Record<string, any>;
    expect(reply.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(server.pendingRequests().length).toBe(0);
  });

  test("hold-open ceiling falls back to the timeout decision (never wedges)", async () => {
    const events: IREvent[] = [];
    const { sock } = makeServer(events, undefined, 80);
    const reply = (await post(sock, "/hook", PRETOOL_PAYLOAD)) as Record<string, any>;
    expect(reply.hookSpecificOutput.permissionDecision).toBe("ask");
    const resolved = events.find((e) => e.kind === "permission.resolved");
    expect(resolved?.kind === "permission.resolved" && resolved.source).toBe("timeout");
  });

  test("Stop hook becomes turn.complete with the last assistant message", async () => {
    const events: IREvent[] = [];
    const { sock } = makeServer(events);
    await post(sock, "/hook", STOP_PAYLOAD);
    const done = events.find((e) => e.kind === "turn.complete");
    expect(done?.kind === "turn.complete" && done.lastAssistantMessage).toContain(
      "genesis-probe-ok",
    );
  });

  test("SessionStart carries the transcript path (the contract pointer)", async () => {
    const events: IREvent[] = [];
    const { sock } = makeServer(events);
    await post(sock, "/hook", {
      session_id: "s1",
      transcript_path: "/abs/path/s1.jsonl",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    const ready = events.find((e) => e.kind === "session.lifecycle");
    expect(ready?.kind === "session.lifecycle" && ready.transcriptPath).toBe("/abs/path/s1.jsonl");
  });

  test("hooks carry the live content plane (verbatim T7 probe payloads)", async () => {
    const events: IREvent[] = [];
    const { sock } = makeServer(events, () => ({ decision: "allow" }));
    const common = {
      session_id: "s7",
      transcript_path: "/tmp/x/s7.jsonl",
      cwd: "/tmp/x",
      permission_mode: "default",
    };
    await post(sock, "/hook", {
      ...common,
      hook_event_name: "UserPromptSubmit",
      prompt: "Run exactly this bash command and tell me its output: echo t7-marker-ok",
    });
    await post(sock, "/hook", {
      ...common,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo t7-marker-ok" },
      tool_use_id: "toolu_t7",
    });
    await post(sock, "/hook", {
      ...common,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo t7-marker-ok" },
      tool_response: {
        stdout: "t7-marker-ok",
        stderr: "",
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
      tool_use_id: "toolu_t7",
      duration_ms: 12,
    });
    await post(sock, "/hook", {
      ...common,
      hook_event_name: "MessageDisplay",
      turn_id: "b6530707-792e-4910-a76e-9306770d3317",
      message_id: "92a91ee1-aa63-4f6d-aa7d-ce901bf26d8b",
      index: 0,
      final: false,
      delta: "The command output is:\n\n```\nt7-marker-ok\n",
    });
    await post(sock, "/hook", {
      ...common,
      hook_event_name: "MessageDisplay",
      turn_id: "b6530707-792e-4910-a76e-9306770d3317",
      message_id: "92a91ee1-aa63-4f6d-aa7d-ce901bf26d8b",
      index: 1,
      final: true,
      delta: "```",
    });

    const user = events.find((e) => e.kind === "message.user");
    expect(user?.kind === "message.user" && user.text).toContain("t7-marker-ok");

    const use = events.find((e) => e.kind === "tool.use");
    expect(use?.kind === "tool.use" && use.name).toBe("Bash");
    expect(use?.kind === "tool.use" && use.toolUseId).toBe("toolu_t7");

    const result = events.find((e) => e.kind === "tool.result");
    expect(result?.kind === "tool.result" && (result.content as { stdout?: string }).stdout).toBe(
      "t7-marker-ok",
    );
    expect(result?.kind === "tool.result" && result.isError).toBe(false);
    expect(result?.kind === "tool.result" && result.durationMs).toBe(12);

    const deltas = events.filter((e) => e.kind === "message.assistant");
    expect(deltas.length).toBe(2);
    const assembled = deltas.map((e) => (e.kind === "message.assistant" ? e.text : "")).join("");
    expect(assembled).toContain("t7-marker-ok");
    const last = deltas[1];
    expect(last?.kind === "message.assistant" && last.streaming?.final).toBe(true);
    expect(last?.kind === "message.assistant" && last.streaming?.index).toBe(1);
  });

  test("unknown hook events are passthrough, never an error response", async () => {
    const events: IREvent[] = [];
    const { sock } = makeServer(events);
    const reply = await post(sock, "/hook", {
      session_id: "s1",
      hook_event_name: "FutureHookNobodyKnows",
    });
    expect(reply).toEqual({});
    expect(events.some((e) => e.kind === "unknown")).toBe(true);
  });

  test("statusline payload becomes a status event and prints a stable line", async () => {
    const events: IREvent[] = [];
    const { sock } = makeServer(events);
    const res = await fetch("http://genesis/statusline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s1",
        model: { id: "claude-opus-4-8", display_name: "Opus" },
        cost: { total_cost_usd: 1.23 },
        context_window: { used_percentage: 41 },
        version: "2.1.173",
      }),
      unix: sock,
    });
    expect(await res.text()).toBe("genesis");
    const status = events.find((e) => e.kind === "status");
    expect(status?.kind === "status" && status.model).toBe("Opus");
    expect(status?.kind === "status" && status.contextUsedPct).toBe(41);
    expect(status?.kind === "status" && status.cliVersion).toBe("2.1.173");
  });
});
