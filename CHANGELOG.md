# Changelog

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

### Tests
- +14 (30 total): Store contract, FS-as-truth continuity (close/reopen),
  Supervisor restart resume, and live API durability across a server restart.

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
