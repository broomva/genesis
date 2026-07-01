# Changelog

## [Unreleased] — Durable interactive-session resume + actionable eviction (BRO-1630)

### Fixed
- **Session amnesia (RC1).** The interactive engine now RESUMES a thread's prior
  Claude conversation after a daemon restart / eviction / idle-kill by respawning
  `claude --resume <priorSessionId>` (instead of a fresh `--session-id`) when that
  transcript is still on disk under the thread's cwd. Re-verified live on CLI
  2.1.191/197: `--resume` without `--fork-session` PRESERVES the session id and
  appends to the same transcript, so hook routing is unaffected — no re-keying
  needed (this retires the stale BRO-1485 #2 concern). Safe-degrades to a fresh
  session when no transcript is found. A loud, deduped alarm fires if the CLI ever
  reverts to reassigning the id on resume (would otherwise silently hang a turn).
- **Silent "(no output)" (RC2).** A send-eviction (send not acknowledged after an
  awaiting/HITL turn, or a turn timeout) now returns an actionable reply
  ("couldn't be delivered — resend; context is preserved") instead of a bare
  "(no output)". The reducer's errored branch surfaces an error result's own
  `result` as `lastText` (backward-compatible — error results carried none).

## [Unreleased] — Print engine as the bot default + control/observability parity (BRO-1524)

### Changed
- **Default the Telegram bot to the PRINT engine (`claude -p`).** Anthropic
  PAUSED the June-15 Agent-SDK/`claude -p` metering (verified 2026-06-18 from
  support.claude.com: "we're pausing the changes… nothing has changed"), so
  `claude -p` draws the subscription at no penalty — and the print engine has
  NONE of the interactive engine's tmux/keystroke fragility (source of every
  "stuck"/"wedged" incident). The interactive engine stays as exempt-insurance
  for if/when metering returns (flip `GENESIS_ENGINE=interactive`).

### Fixed / Added
- **`Supervisor.reset` is now engine-agnostic** — clears the stored
  agentSessionId + phase regardless of an engine control surface, so `/new`
  (fresh context) works on the print engine too (was "unsupported"). The
  interactive engine additionally kills its live process.
- **Per-event trace parity for the print engine** — a `trace` hook
  (Supervisor `onState` → `<runsDir>/<sessionId>.jsonl`) gives the print engine
  the same per-turn event record the interactive IR observer provides.
- launchd env template documents the engine choice + billing-pause context.
- +3 core tests (reset without control, no-session, trace hook).


## [Unreleased] — Full end-to-end session observability (BRO-1519)

### Added
- **Per-session IR trace (JSONL)** — `RunLogger` (session-host) subscribes the
  SessionHub firehose via the new `InteractiveEngineConfig.observer` and appends
  EVERY event (`message.*`/`tool.*`/`permission.*`/`status`/`turn.complete`/
  `awaiting`/`error`/`unknown`/`session.lifecycle`) with a timestamp to
  `<GENESIS_RUNS_DIR>/<sessionId>.jsonl` — the complete record for retro-diagnosis.
- **Structured server-side logging** (→ launchd api log): turn boundaries +
  LOUD, detailed lines for every failure/stuck condition. Engine emits
  diagnostics the hooks can't surface (send-not-acknowledged, turn-timeout with
  elapsed/last-event context). Supervisor logs dispatch ▶/✓/✖ (thread→session→
  phase→timing, engine-agnostic — covers print + /message) and now logs the
  FULL error+stack on dispatch failure (was swallowed → generic "Something went
  wrong" with no server trace).
- **No-output detection**: a turn that completes with empty assistant text is
  flagged loudly with the events that DID occur (the "(no output)" symptom).

### Live-verified
- Real turn → full JSONL trace (lifecycle→status→user→tool.use→permission→
  tool.result→assistant→turn.complete) + structured log with per-turn timing.
- +7 RunLogger tests (JSONL append, per-session files, no-output flag, error/
  drift/lifecycle summaries, persist-never-throws).


## [Unreleased] — Run the agent on ~/broomva: owner allowlist + worktree-disable (BRO-1512)

### Added
- **Owner-only Telegram allowlist** (`GENESIS_TELEGRAM_ALLOWED_USERS`, comma-sep
  ids; matches full thread id or bare chat id). When set, the bot serves ONLY
  those threads (others silently ignored + logged). REQUIRED before pointing the
  auto-allow agent at a real workspace — otherwise any Telegram user who DMs the
  bot gets RCE on the owner's machine. Unset → allow-all (sandbox posture).
- **Worktree-disable** (`GENESIS_NO_WORKTREE=1` → Supervisor `noWorktree` →
  runner `worktree:false`): the agent runs DIRECTLY in the workspace instead of
  a per-session worktree. Required for workspaces with nested git repos like
  `~/broomva` (apps/genesis, core/life are nested repos — a worktree checks out
  only the outer repo's tracked files and misses them). Continuity stays via the
  persistent live session.

### Live-verified (~/broomva, allowlist enforced)
- Agent lists the real monorepo top-level (AGENTS.md, apps, core, …), runs in
  `/Users/broomva/broomva`, creates NO `.genesis-runs/` worktree. Bot boots with
  `allowlist ENFORCED`. +14 tests (allowlist parse/match, supervisor worktree
  pass-through).


## [Unreleased] — Harden keystroke actuator + pin-rot fallback (BRO-1494)

### Fixed
- **Wedged composer stranded messages** (3rd live "stuck" incident). The TUI
  composer occasionally entered a state where a bare Enter would not submit
  (diagnosed live: Escape + Ctrl-U + retype + C-m recovers it). The closed-loop
  send's retry now **clears the composer and retypes the full text** instead of
  re-sending a bare Enter, and submit uses **C-m** (the form that reliably
  submitted). `actuator.send(name, text, {clearFirst})` exposes the recovery;
  the trust-dialog nudge never clears (Escape would cancel it).
- **Pin-rot**: Claude Code's auto-updater garbage-collects old versions, so a
  pinned binary (e.g. 2.1.173) vanished out from under the running bot and
  EVERY turn hard-failed. `resolveClaudeBinary` now **falls back to PATH
  `claude` with a warning** when a pin is missing, instead of throwing.
- +tests: clear+retype recovery, clearFirst-on-retries assertion, pin-fallback.
  Live smoke 8/8 on PATH claude (2.1.177).


## [Unreleased] — Native slash-command framework (BRO-1493)

### Added
- **Telegram slash commands mapped to real engine actions** — never typed into
  the TUI. Control set (in the native `/` menu via `setMyCommands`): `/new`
  (reset → fresh agent context), `/stop` (interrupt), `/status` (session state),
  `/commands` (full palette), `/help`. Aliases: `/reset` `/clear`→new,
  `/cancel`→stop, `/skills`→commands, `/start`→help.
- **`/commands` enumerates the session's FULL palette** — built-ins + every
  installed skill (parsed from `SKILL.md` frontmatter) — the "show all commands
  active on the session". Any `/<skill>` typed forwards to the session and runs
  (all skills "inherited"); built-in overlays still decline via the PR#11 floor.
- **Genesis `/control` surface** (`POST /control {threadId, action}`) →
  Supervisor resolves thread→session and delegates to the interactive engine's
  new `reset`/`interrupt`/`status` methods. Print engine → "unsupported".
- Routing lives in the message handler (Telegram delivers commands as normal
  messages, not SlashCommandEvents) — channel-agnostic, central.

### Live-verified
- `/control reset` killed the live session → the agent FORGOT a planted codeword
  (`NO-MEMORY`) on the next turn (fresh context); `status` flipped live→idle;
  unknown action → 400; native menu registered on @Broomvatechbot (5 commands).
- +25 tests (engine control, command parsing/routing, palette enumeration, render).


## [Unreleased] — Telegram bot: durable subscriptions + DM robustness (BRO-1492)

### Fixed
- **Bot restart silently dropped all active conversations.** `index.ts` used
  `createMemoryState()`, so subscriptions lived in process memory; after a
  restart an ongoing DM was neither a *new mention* nor *subscribed*, so neither
  handler fired and the message was consumed-then-dropped (Telegram
  `pending_update_count`→0, no handler log, no `/api/chat` hit). Two fixes:
  - **`onDirectMessage`** now handles every DM regardless of subscription — the
    idiomatic, restart-proof path for direct messages.
  - **`FileStateAdapter`** (new) persists group subscriptions to JSON under
    `GENESIS_BOT_STATE_DIR` (ephemeral locks/queues delegate to memory — a dead
    process's lock must not survive it). Redis stays the multi-replica prod
    option; file-state fits the single-instance owned-compute tier.
- `seed()` supports pre-subscribing a known thread for immediate recovery.
- +6 FileStateAdapter tests (survive-restart, unsubscribe, seed, corrupt-file,
  ephemeral-not-persisted, path).


## [Unreleased] — Slash-command interception in the interactive engine (BRO-1485 #10)

### Fixed
- **`/model` (and other built-in Claude Code TUI commands) wedged the chat
  session** (caught live via Telegram, 2026-06-12). Typed into the interactive
  TUI they open an overlay/menu — not an agent turn — so no Stop hook fires;
  the engine hung (pre-#9) or killed the session on a no-ack timeout after
  typing stray menu keystrokes (post-#9). The interactive engine now
  **intercepts built-in slash commands before touching any session** and
  replies with a helpful message; the keystrokes are never injected. Normal
  prompts and turn-producing skill commands (`/autonomous`, …) are unaffected.
  Live-verified: `/model` → reply in 49ms, zero session spawned; a normal
  prompt still spawns and replies. +17 tests (`slash.ts` matcher incl.
  file-path/skill-command false-positive guards, +2 engine short-circuit tests).


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
  **(Superseded 2026-07-01 by BRO-1630 — durable `--resume` now restores prior
  conversation context across a restart; see the top Unreleased entry.)**

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
