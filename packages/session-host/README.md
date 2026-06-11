# @genesis/session-host

Contract-first wrap of **interactive** Claude Code (Path B, exempt mode — never
`-p`). Spawns pinned `claude` binaries in tmux, observes them exclusively
through documented contract surfaces, and emits a typed event IR that the UI
(and any other consumer) depends on instead of any CLI internals.

## Architecture (the stability ladder — BRO-1475, corrected by BRO-1484 smoke)

| Plane | Surface | Stability |
|---|---|---|
| Control | Hooks API (`PreToolUse` permission hold-open, `Stop` turn-complete, `Notification` awaiting, `SessionStart` transcript-path delivery) | documented contract |
| **Content** | **Hooks API** — `UserPromptSubmit` (user turn), `PreToolUse` (tool.use), `PostToolUse` (`tool_response` → tool.result), `MessageDisplay` (**streaming assistant deltas**: `turn_id`/`message_id`/`index`/`final`/`delta`, v2.1.152+) | documented contract |
| Status | statusline stdin JSON (model, cost, context %, version) | documented contract |
| History/recovery | transcript JSONL via `TranscriptTailer` + tolerant `ClaudeCodeAdapter` | see persistence note below |
| Input | tmux keystrokes (text + Enter, Escape) — isolated in `actuator.ts` | fragile, contained |
| Fallback | raw PTY bytes via `pipe-pane` → client xterm.js | render-only, never parsed |

### Transcript persistence is entrypoint-dependent (probed 2026-06-11, v2.1.173)

The original Path B design assumed the session transcript streams content at
block granularity. **The live smoke disproved that for our spawn mode**:

| Session entrypoint | Transcript content |
|---|---|
| `cli` + TTY (tmux — our case) | **NOT persisted live** (only `ai-title`); not even flushed on `/exit` in our probes |
| `cli` no-TTY (positional prompt, headless) | flushed at process exit |
| `sdk-ts` (Agent SDK-driven) | written live |

Hence the content plane is **hooks** (documented, streaming, works in every
mode); the transcript tailer stays as a recovery/history surface for session
modes that do persist, and for `--resume` history rebuilds.

Key invariants:

- **Unknown ≠ fatal.** Unrecognized transcript entries / hook payloads become
  `unknown` IR events with drift telemetry (`session.drift`). The stream never
  stalls on new CLI versions.
- **`transcript_path` comes from hook input** — never reconstructed from cwd
  (the lossy `~/.claude/projects` path encoding breaks reconstruction).
- **No TUI text parsing anywhere.**
- **Version pinning**: sessions spawn `~/.local/share/claude/versions/<pin>`
  with `DISABLE_AUTOUPDATER=1`. Bump the pin only after the live smoke passes
  against the candidate version.

## Usage

```ts
import { SessionHub } from "@genesis/session-host";

const hub = new SessionHub({ socketPath: "/tmp/genesis.sock" });
hub.start();
hub.onEvent((e) => console.log(e.kind, e.sessionId));

const session = await hub.createSession({
  cwd: "/path/to/repo",
  pin: "2.1.173",
  policy: ({ toolName }) => (toolName === "Read" ? { decision: "allow" } : undefined),
});
await session.send("refactor the parser");
// permission.request events → hub.respondPermission(requestId, "allow" | "deny")
```

## Testing

- `bun test` — contract tests over **real captured payloads**: the v2.1.173
  transcript fixture (`test/fixtures/`), verbatim hook payloads from the
  2026-06-11 probes (PreToolUse/Stop/UserPromptSubmit/PostToolUse/
  MessageDisplay), tailer recovery, and the unix-socket permission round-trip
  (including a >10s hold-open).
- `bun run smoke` (`GENESIS_LIVE=1`) — the **golden live smoke**: spawns a real
  pinned claude in tmux, runs a scripted turn, asserts the full IR sequence
  (prompt → hook-resolved permission → tool flow → streaming deltas →
  `turn.complete`). Run with `--latest` against PATH `claude` before promoting
  a pin bump — this is the canary lane. **Run it from a non-sandboxed shell**
  (a sandbox-inherited tmux server invalidates the environment).
- `bun run dev-client` — interactive scratch client (turns from your terminal,
  permission cards answered with `y/n <request-id>`).

## Known limitations (spike)

- **Folder-trust dialog**: a fresh cwd shows the trust prompt before any hook
  fires; the smoke sends one Enter after 12s of silence. The daemon should
  pre-trust managed worktrees (or accept via the same nudge) — tracked for the
  productization pass.
- Thinking blocks are not delivered by `MessageDisplay`; they exist only on the
  transcript surface (when persisted). Acceptable for v1.

## When a new Claude Code version drifts

1. The smoke's drift report names the unknown tags (transcript + hook surfaces).
2. Capture fresh fixtures (hook payloads + transcript if persisted) into
   `test/fixtures/v<version>-….jsonl`.
3. Teach `control.ts`/`adapter.ts` the new shape (or add to `SILENT_TYPES` if noise).
4. Green smoke → bump the pin.
