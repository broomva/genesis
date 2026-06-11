// live-smoke — the golden contract test against a REAL Claude Code binary.
//
// This is the canary lane (stability-ladder): run it against the pinned
// version on every change, and against `latest` before promoting a pin bump.
// It exercises the full acceptance loop of BRO-1484:
//
//   spawn (tmux, pinned bin, per-session --settings)
//     → SessionStart hook delivers transcript_path  → tailer attaches
//     → scripted turn → PreToolUse held → policy auto-allow resolves it
//     → tool.use / tool.result stream from the transcript
//     → Stop hook → turn.complete
//
// Exit code 0 = contract intact. Non-zero = drift (report printed).
//
// Usage:
//   GENESIS_LIVE=1 bun scripts/live-smoke.ts [--pin 2.1.173] [--latest]
//   --latest uses PATH `claude` (the canary-vs-latest run).

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IREvent } from "../src/ir";
import { SessionHub } from "../src/session";

if (process.env.GENESIS_LIVE !== "1") {
  console.log("live-smoke skipped (set GENESIS_LIVE=1 to run against a real claude)");
  process.exit(0);
}

const args = process.argv.slice(2);
const pinFlag = args.indexOf("--pin");
const useLatest = args.includes("--latest");
const pin = useLatest ? undefined : pinFlag >= 0 ? args[pinFlag + 1] : "2.1.173";

const MARKER = `genesis-smoke-${Date.now().toString(36)}`;
const TIMEOUT_MS = 120_000;

function note(msg: string): void {
  console.log(`[smoke] ${msg}`);
}

// Scratch cwd: a fresh git repo (sessions are repo-scoped in the product).
const cwd = await mkdtemp(join(tmpdir(), "gen-smoke-"));
await Bun.spawn(["git", "init", "-q"], { cwd }).exited;
await writeFile(join(cwd, "README.md"), "# smoke\n");

const sockDir = await mkdtemp(join(tmpdir(), "gen-smoke-sock-"));
const events: IREvent[] = [];
const seen = new Set<string>();
let allowedRequest = false;

const hub = new SessionHub({
  socketPath: join(sockDir, "control.sock"),
  policy: ({ toolName, toolInput }) => {
    const command = (toolInput as { command?: string } | undefined)?.command ?? "";
    if (toolName === "Bash" && command.startsWith(`echo ${MARKER}`)) {
      allowedRequest = true;
      return { decision: "allow", reason: "smoke policy: marker echo" };
    }
    return { decision: "deny", reason: "smoke policy: only the marker echo is allowed" };
  },
});
hub.start();
hub.onEvent((e) => {
  events.push(e);
  const summary =
    e.kind === "message.assistant" || e.kind === "thinking"
      ? `${e.kind}: ${e.text.slice(0, 60).replaceAll("\n", "\\n")}`
      : e.kind === "tool.use"
        ? `tool.use: ${e.name} ${JSON.stringify(e.input).slice(0, 60)}`
        : e.kind === "tool.result"
          ? `tool.result: ${String(e.content).slice(0, 60).replaceAll("\n", "\\n")}`
          : e.kind === "unknown"
            ? `unknown(${e.surface}): ${e.tag}`
            : e.kind;
  if (!seen.has(summary) || e.kind === "unknown") note(`event ${summary}`);
  seen.add(summary);
});

note(`spawning claude (${pin ?? "PATH latest"}) in ${cwd}`);
const session = await hub.createSession({
  cwd,
  pin,
  initialPrompt: `Run exactly this bash command and then tell me its output: echo ${MARKER}`,
  rawSinkPath: join(sockDir, "raw.bytes"),
});

function has(predicate: (e: IREvent) => boolean): boolean {
  return events.some(predicate);
}

const deadline = Date.now() + TIMEOUT_MS;
let trustNudged = false;
while (Date.now() < deadline) {
  // Startup-grace: a fresh cwd can show the folder-trust dialog (the one
  // startup interaction with no hook surface). One Enter accepts the default.
  if (
    !trustNudged &&
    Date.now() > deadline - TIMEOUT_MS + 12_000 &&
    !has((e) => e.kind === "session.lifecycle" && e.phase === "ready")
  ) {
    note("no SessionStart after 12s — nudging possible trust dialog (single Enter)");
    await session.send("");
    trustNudged = true;
  }
  if (has((e) => e.kind === "turn.complete")) break;
  await Bun.sleep(150);
}

// Give trailing hook deliveries (PostToolUse/MessageDisplay racing Stop) a beat.
await Bun.sleep(1_500);

// --- assertions -------------------------------------------------------------
// The content plane is HOOKS (UserPromptSubmit/PreToolUse/PostToolUse/
// MessageDisplay) — plain TTY-interactive sessions do not persist transcript
// content live (discovered by this smoke, 2026-06-11, v2.1.173).
const checks: Array<[string, boolean]> = [
  ["SessionStart hook delivered transcript_path", session.transcriptPath !== undefined],
  [
    "user prompt observed (UserPromptSubmit)",
    has((e) => e.kind === "message.user" && e.text.includes(MARKER)),
  ],
  ["permission auto-allowed via PreToolUse policy", allowedRequest],
  [
    "permission.resolved(source=policy) emitted",
    has((e) => e.kind === "permission.resolved" && e.source === "policy" && e.decision === "allow"),
  ],
  ["tool.use observed (PreToolUse)", has((e) => e.kind === "tool.use" && e.name === "Bash")],
  [
    "tool.result carries the marker (PostToolUse)",
    has((e) => e.kind === "tool.result" && JSON.stringify(e.content).includes(MARKER)),
  ],
  [
    "assistant deltas streamed (MessageDisplay)",
    events
      .filter((e) => e.kind === "message.assistant" && e.surface === "hook")
      .map((e) => (e.kind === "message.assistant" ? e.text : ""))
      .join("")
      .includes(MARKER),
  ],
  ["turn.complete from Stop hook", has((e) => e.kind === "turn.complete")],
];

// Informational (not pass/fail): did this environment persist the transcript?
const transcriptContent = events.some((e) => e.surface === "transcript" && e.kind !== "unknown");
note(
  `transcript persistence in this environment: ${transcriptContent ? "LIVE/CONTENT" : "buffered (expected for plain TTY-interactive cli sessions)"}`,
);

note("");
note(`binary: ${pin ?? "PATH latest"} · events: ${events.length} · drift: ${session.drift.total}`);
let failed = false;
for (const [label, ok] of checks) {
  note(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failed = true;
}
if (session.drift.total > 0) {
  note(`⚠️  transcript drift detected: ${JSON.stringify(session.drift.bySurface.transcript)}`);
}
const hookUnknowns = events.filter((e) => e.kind === "unknown" && e.surface === "hook");
if (hookUnknowns.length > 0) {
  note(
    `⚠️  unknown hook payloads: ${hookUnknowns.map((e) => (e.kind === "unknown" ? e.tag : "")).join(", ")}`,
  );
}

await session.kill();
await hub.stop();
process.exit(failed ? 1 : 0);
