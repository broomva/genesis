# Changelog

## [Unreleased] — Phase 4: Host Abstraction · microVM tier = Vercel Sandbox (BRO-1360)

### Added
- `@genesis/host` `VercelSandboxHost` — the microVM `ExecutionHost` tier
  (`kind: "microvm"`, `credentialTier: "keyed"`) backed by Vercel Sandbox
  (Firecracker microVMs, deny-all egress, snapshot API). Lights up the optional
  `ExecutionHost.snapshot?()` capability.
- `createVercelSandboxHost()` factory — lazy-imports `@vercel/sandbox`; per-session
  persistent VMs via `Sandbox.get({name})` (continuity composes with the Phase-2
  store); git source; boundary-injected keyed creds (`ANTHROPIC_API_KEY`);
  `deny-all` default; optional one-time bootstrap commands.
- API host selection: `GENESIS_HOST=vercel` runs the agent in a Vercel Sandbox
  (see `.env.example`). Default stays `LocalHost` — no behavior change.

### Changed
- Runner is microVM-aware: on a `microvm` host it skips the local git worktree
  (the VM is the isolation boundary) and runs at `remoteCwd` (default
  `/vercel/sandbox`).

### Fixed
- Latent Phase-1 bug: a cut worktree was created but the agent still ran in the
  main tree (`runCwd` was never reassigned). The agent now runs INSIDE the
  worktree (regression-tested).

### Tests
- +14 (44 total): VercelSandboxHost (injected `SandboxLike` fake — CI needs no
  cloud creds), log line-buffering, runner microVM branch (no worktree), and the
  worktree-cwd regression guard. Live Vercel integration is env-gated.

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
