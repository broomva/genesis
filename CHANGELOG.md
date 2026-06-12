# Changelog

## [Unreleased] — Closed-loop send: UserPromptSubmit as the actuator ack (BRO-1485 #9)

### Fixed
- **Eaten-Enter race in `SessionHost.send()`** (caught live via Telegram,
  2026-06-12): typing a turn too close to the previous turn's TUI tail could
  eat the trailing Enter — the prompt sat unsubmitted in the composer while
  the dispatch held its per-thread lock to the turn timeout (which kills the
  session post-B1). `send()` is now **closed-loop**: type + Enter → await the
  `UserPromptSubmit` hook ack (fires iff the prompt actually submits) → on
  miss, re-send a bare Enter (text already in the composer) → bounded retries
  (default 2) → throw. Empty-text sends (trust nudge) stay fire-and-forget.
  Tunables: `submitAckMs` (3000), `submitRetries` (2). +4 tests incl. the
  live-bug repro.


## [Unreleased] — Exempt interactive engine: GENESIS_ENGINE=interactive (BRO-1488)

### Added
- **`createInteractiveEngine`** (`@genesis/runner`): an alternate `RunnerFn`
  backed by `@genesis/session-host` — ONE persistent **interactive** Claude
  Code session per Genesis sessionKey (positional prompt, never `-p` — the
  exempt subscription class). First turn spawns; later turns `send()` into the
  live process. IR events are translated into the print engine's `AgentEvent`
  shapes, so the projection reducer, Supervisor, and `/api/chat` are untouched.
  AskUserQuestion still gates `awaiting` (HITL preserved); turn timeout →
  `blocked`; dead sessions respawn with a fresh sessionId; trust-dialog Enter
  nudge after 12s of hook silence.
- **`GENESIS_ENGINE=interactive`** in `apps/api` (opt-in; default `print`
  unchanged). Local-host only — boot-errors under `GENESIS_HOST=vercel`.
  `GENESIS_CLAUDE_PIN` pins the CLI version; `GENESIS_TURN_TIMEOUT_MS`
  overrides the 10-min turn ceiling. SIGTERM/SIGINT kill live agent tmux
  sessions.
- `ensureSessionWorktree()` extracted from `runAgent` (shared by both engines).

### Live validation (2026-06-11)
- Two-turn `/message` round-trip: codeword planted turn 1 (15s incl. spawn),
  recalled turn 2 in **2.4s** (~6× faster than spawn-per-turn) through the SAME
  live session — multi-turn continuity WITHOUT `--resume`. Clean SIGINT reaped
  the tmux session.
- `resumeSessionId` is ignored with a notice (resume re-keying: BRO-1485);
  daemon restart starts a fresh agent session in the same persistent worktree.

## [Unreleased] — Path B session-host: contract-first wrap of interactive Claude Code (BRO-1484)

### Added
- **`packages/session-host`** — `@genesis/session-host`: persistent **interactive**
  Claude Code sessions (exempt mode — never `-p`) wrapped on documented contract
  surfaces only (the BRO-1475 stability ladder). `SessionHub` (one unix socket,
  N sessions) + `SessionHost` (tmux-spawned pinned binary + per-session
  `--settings` hook/statusline injection) + typed event IR.
- **Hook control plane**: PreToolUse **hold-open permission flow** (policy
  auto-resolve or UI card via `respondPermission`; timeout falls back to `ask`,
  never wedges), Stop → `turn.complete` (deterministic, no quiescence
  heuristics), Notification → `awaiting`, SessionStart → transcript-path
  delivery (never reconstructed from cwd).
- **Hook content plane**: `UserPromptSubmit` → user turns, `PreToolUse`/
  `PostToolUse` → tool flow with structured `tool_response`, **`MessageDisplay`
  → streaming assistant deltas** (`turn_id`/`message_id`/`index`/`final`).
- **Tolerant transcript adapter** (history/recovery surface): unknown entry
  types → passthrough `unknown` IR events with drift telemetry; uuid-only
  dedupe (`message.id` is NOT a valid key — one message spans multiple block
  lines); never stalls on new CLI versions.
- **Contract test harness**: 19 unit tests over real captured v2.1.173 payloads
  (transcript fixture + verbatim hook payloads) + `bun run smoke` golden live
  smoke (the canary lane that gates version-pin bumps; `--latest` for the
  candidate run). Version pinning via `~/.local/share/claude/versions/<pin>` +
  `DISABLE_AUTOUPDATER=1`.

### Discovered (architecture-correcting)
- **Transcript persistence is entrypoint-dependent on v2.1.173**: plain
  TTY-interactive `cli` sessions do NOT write conversation content to the
  session JSONL live (only `ai-title`); `cli` no-TTY flushes at exit; `sdk-ts`
  sessions write live. The Path B content plane therefore moved from
  transcript-tailing to the documented hooks surface — found by the live smoke
  on its first run.

## [Unreleased] — Fix: LocalHost multi-turn resume (per-session worktree) (BRO-1473)

### Fixed
- **Multi-turn conversations on LocalHost returned `"(no output)"` after the first
  turn.** `runAgent` cut a fresh git worktree per run and removed it, but
  `claude --resume` is cwd-scoped — resumed turns ran in a new worktree where the
  session didn't exist, so the agent produced no text. Now a **per-session worktree**
  (`.genesis-runs/session-<id>`) is reused across turns (`sessionKey` option;
  `worktreePersistent` kept across turns, not removed per-turn). The microVM path
  was already immune (persistent VM per session). Found by the live Telegram test.

### Tests
- +3 runner tests: sessionKey → stable persistent worktree; reuse-if-exists (no
  second `worktree add`); one-shot runs stay per-run. Multi-turn verified live —
  resumed turns reply and the agent recalls prior turns.


## [Unreleased] — Chat SDK (vercel/chat) Telegram channel (BRO-1472)

### Added
- `apps/chat-bot` — a **Chat SDK** (`vercel/chat`) Telegram bot that fronts the
  Genesis engine. Polling mode (no webhook/public URL); each Telegram thread maps
  to a Genesis session (`thread.id`), so the agent keeps per-conversation context
  and (with `GENESIS_HOST=vercel`) runs in its own Firecracker microVM.
- `genesisStream()` — bridges Genesis's `/api/chat` (AI SDK UI message stream)
  into an `AsyncIterable<string>` for `thread.post()`; multi-block narration
  separated by blank lines; chunk-boundary-safe SSE parsing; errors surfaced.
- `handleAgentMessage()` — the channel handler (typing indicator, stream, failure
  → posted `⚠️` message). Decoupled via a minimal thread interface (unit-testable).

### Grounding
- Built against the **real** `chat@4.30.0` + `@chat-adapter/telegram@4.30.0` +
  `@chat-adapter/state-memory@4.30.0` API (read from `github.com/vercel/chat`
  SKILL.md + the `telegram-chat` example, not training data).

### Tests
- +12 (92 total): `parseSse` (frames, chunk splits, `[DONE]`/keepalive skip),
  `genesisStream` (single + multi-block, continuity id, error + non-2xx),
  `handleAgentMessage` (stream, empty-skip, failure-as-message, continuity).
  Typecheck passes against the real Chat SDK types. The bridge was live-verified
  against the deployed Genesis (it streamed + correctly surfaced an engine error).


## [Unreleased] — Chat SDK channel (AI SDK UI message stream) (BRO-1445)

### Added
- `apps/api/src/channel/` — the **ChannelConnector seam** (channel-connector-trait
  KG pattern): canonical `IncomingMessage`/`OutgoingEvent`, a `ChannelConnector`
  interface, and the `ChatSdkConnector` that speaks the **Vercel AI SDK UI message
  stream protocol** (`start`/`text-start`/`text-delta`/`text-end`/`finish` SSE
  parts, `data: [DONE]` terminator, `x-vercel-ai-ui-message-stream: v1` header).
- `POST /api/chat` — any `useChat`/`DefaultChatTransport` client (or curl) drives
  Genesis directly: parse AI SDK request → `Supervisor.dispatch` → stream run
  phases + reply as UI message stream parts. **The Hono server IS the channel —
  no separate frontend.**
- `eventStream()` bridge — turns the Supervisor's onState callback into the
  `AsyncIterable<OutgoingEvent>` the connector streams.

### Protocol correctness (P20 round-1 fixes — 4/10 → addressed)
- **HIGH-1 multi-turn concatenation**: the reducer's `lastText` is the latest
  text BLOCK, not a growing string; successive blocks are unrelated. Since the AI
  SDK client APPENDS every `text-delta`, the old "emit whole on non-prefix" path
  concatenated unrelated turns into garbled text. Now: prefix-extending text
  streams as suffix deltas (one part); a NON-prefix block closes the current part
  (`text-end`) and opens a new one (`text-start` + fresh id) — blocks render
  separately, never concatenated.
- **HIGH-2 dangling open part on error**: the error tail (`text-end` → `error` →
  `finish`) now lives inside `toUiStreamParts` under a try/catch, so it ALWAYS
  runs — including when the upstream `Supervisor.dispatch` REJECTS (the common
  failure path) — leaving no perpetually-streaming open text part.

### Tests
- +23 (101 total): `parseChatRequest`, exact SSE wire bytes, **multi-block
  separation with realistic non-prefix data (HIGH-1)**, prefix-extend suffix
  streaming, **thrown-rejection closes text-end before error (HIGH-2)**,
  no-text-emitted rejection, empty-skip, and the callback→iterable bridge.
- **Live-verified by curl**: a real AI SDK request drove a live agent and streamed
  back a structurally-valid `start → text-delta → text-end → finish → [DONE]`
  (started==ended ids, no dangling part). Multi-block separation is proven
  deterministically by unit test (agents don't reliably emit preamble text on
  demand, so the non-prefix path is covered with fixed fixtures).

## [Unreleased] — Per-session microVMs + AI Gateway (BRO-1448)

### Added
- `@genesis/host` `HostProvider` seam (`resolveHost(session) → HostLease`) +
  `StaticHostProvider` (default — wraps one host). The Supervisor now leases a
  host per session and releases it after the turn.
- `VercelSandboxHostProvider` — each chat thread gets its OWN persistent
  Firecracker microVM (`Sandbox.getOrCreate({name: sessionId})`): warm-cached,
  concurrent-create-deduped, retried on failure, `shutdown()` stops all.
- `aiGatewayEnv()` — routes the sandboxed Claude Code CLI through **Vercel AI
  Gateway** (`ANTHROPIC_BASE_URL=https://ai-gateway.vercel.sh`,
  `ANTHROPIC_AUTH_TOKEN=<key>`, `ANTHROPIC_API_KEY=""`). Token = `AI_GATEWAY_API_KEY`
  or `VERCEL_OIDC_TOKEN` (one token authenticates the gateway AND the sandbox).
- API: `GENESIS_HOST=vercel` now wires the per-session provider; fails fast
  without a gateway token. Graceful shutdown stops all warm sandboxes.

### Changed
- Default egress allow-list is now `ai-gateway.vercel.sh` (+ npm) — the agent
  reaches the LLM via the gateway, not `api.anthropic.com` directly.
- `Supervisor` takes `hostProvider?` (or `host?` shorthand, wrapped). Lease's
  `remoteCwd` takes precedence over the Supervisor default.

### Tests
- +9 (58 total): `aiGatewayEnv`, `StaticHostProvider`, and
  `VercelSandboxHostProvider` (per-session create, reuse, concurrent-dedup,
  release/evict, failure-retry, shutdown) via an injected `SandboxCreator` fake.
- **Live-verified against real Vercel Sandbox** (`sandbox-live.test.ts` run with
  a pulled `VERCEL_OIDC_TOKEN`): a real Firecracker VM created, commands ran,
  stdout streamed, VM stopped (8.5s).

## [Unreleased] — Phase 4: Host Abstraction · microVM tier = Vercel Sandbox (BRO-1360)

### Added
- `@genesis/host` `VercelSandboxHost` — the microVM `ExecutionHost` tier
  (`kind: "microvm"`, `credentialTier: "keyed"`) backed by Vercel Sandbox
  (Firecracker microVMs, snapshot API). Lights up the optional
  `ExecutionHost.snapshot?()` capability.
- `createVercelSandboxHost()` factory — lazy-imports `@vercel/sandbox`; per-session
  persistent VMs via `Sandbox.getOrCreate({name})` (continuity composes with the
  Phase-2 store); git source; boundary-injected keyed creds (`ANTHROPIC_API_KEY`);
  optional one-time bootstrap commands (stop-on-failure → never leaks a VM).
- Egress: deny-by-default **allow-list** (`DEFAULT_AGENT_ALLOWLIST` —
  api.anthropic.com + npm registries) so the keyed agent can reach the LLM while
  everything else is denied. `networkPolicy` accepts `"deny-all"`/`"allow-all"`/an
  allow-list object. NOTE: the default is intentionally narrow — tasks that
  git-push, clone other repos, pip-install, or call MCP servers need a wider
  `GENESIS_NETWORK_POLICY` allow-list (see `.env.example`).
- API host selection: `GENESIS_HOST=vercel` runs the agent in a Vercel Sandbox
  (see `.env.example`); graceful-shutdown handler calls `stop()` so the
  persistent-by-default VM snapshots on exit. Default stays `LocalHost`.

### Changed
- Runner is microVM-aware: on a `microvm` host it skips the local git worktree
  (the VM is the isolation boundary) and runs at `remoteCwd` (default
  `/vercel/sandbox`). `remoteCwd` is threaded API → Supervisor → runner.

### Fixed
- Latent Phase-1 bug: a cut worktree was created but the agent still ran in the
  main tree (`runCwd` was never reassigned). The agent now runs INSIDE the
  worktree (regression-tested).
- F16 line cap (16 MiB) now also applies to the microVM stdout path
  (`linesFromLogs`), not just `LocalHost`.

### Tests
- +19 (49 total, 1 env-gated skip): VercelSandboxHost (injected `SandboxLike`
  fake — CI needs no cloud creds), log line-buffering + the line cap, bootstrap
  stop-on-failure (no VM leak), runner microVM branch (no worktree), worktree-cwd
  regression guard, Supervisor `remoteCwd` threading, and a real **env-gated live
  Vercel integration test** (`sandbox-live.test.ts`, skips without Vercel auth).

## [Unreleased] — Phase 2: Soul Substrate · Slice A — durable persistence (BRO-1358)

### Added
- `@genesis/db` — durable `DrizzleStore` (Drizzle schema for workspaces/sessions/turns).
  Driver-agnostic factories: `createPgliteStore(dir?)` (pglite — persistent
  FS-as-truth default, in-memory for tests) and `createPostgresStore(url)`
  (Railway Postgres in prod via `DATABASE_URL`).
- API + CLI are **durable by default** (pglite at `~/.genesis/data`;
  `DATABASE_URL` → Postgres). Sessions + resume continuity (`agentSessionId`)
  now survive a process restart.

### Changed
- `Store` contract is now **async**; `Supervisor.resolve`/`history` are async.
  `InMemoryStore` retained for dev/tests.

### Deploy constraint
- **Run a single instance** until Slice B (Upstash slot-locks). Dispatch is
  serialized per-thread *in-process only*; two replicas on one Postgres can race
  the same thread and corrupt `--resume` continuity. The `thread_id` UNIQUE
  constraint turns that race into a loud error rather than silent corruption.

### Tests
- +tests: Store contract, FS-as-truth continuity (close/reopen),
  Supervisor restart resume, live API durability across a server restart,
  deterministic turn ordering for same-millisecond turns, and supervisor retry
  after a transient first-dispatch store failure.

## [Unreleased] — Phase 1: Walking Skeleton (BRO-1357)

### Added
- Greenfield all-TypeScript monorepo (Bun + Turborepo + Biome).
- `@genesis/projection` — NDJSON parser + run-phase projection reducer
  (`running/awaiting/blocked/done`), TDD'd against recorded fixtures.
- `@genesis/host` — `ExecutionHost` seam with `LocalHost` + `VpsHost`
  (`snapshot?` optional; microVM deferred to Phase 4).
- `@genesis/runner` — spawn `claude -p --output-format stream-json` in an
  isolated git worktree, fold output through the reducer.
- `@genesis/core` — domain model + `Supervisor` (resolve → dispatch),
  injectable runner for CI-safe unit tests.
- `@genesis/api` — Hono server (`/message`, live `/ws`), local web channel, CLI.
