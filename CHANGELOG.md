# Changelog

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
