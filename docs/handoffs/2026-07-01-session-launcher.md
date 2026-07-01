# Session Launcher (BRO-1635) — Phase A start: New Workspace by git URL

**TL;DR.** The Omnara-inspired Session Launcher is planned, spec'd, and ticketed; the prior session-resume incident (BRO-1630) is fully fixed + deployed + dogfooded. **First action:** build **BRO-1629 slice 5 — `POST /workspaces {gitUrl}`** (server-side URL validation → clone into the allow-root → register), starting from `apps/api/src/workspace-provision.ts` + `server.ts`, mirroring the existing discover→pick (`resolvePick`) security spine.

---

## State of the world (P15 snapshot 2026-07-01)

- **`~/broomva/apps/genesis`** (repo `github.com/broomva/genesis`) — branch **`main`**, **clean tree, 0/0 with origin**, **0 open PRs**, **no worktrees**. HEAD **`0d7f601`**.
  - `0d7f601` session-launcher spec · `1b2a7f4` BRO-1630 handoff · `c2540ac` (#77 fix-forward) · `c9623f9` (#76 RC3/slice-4) · `b9587ad` (#75 RC1+RC2).
- **Deployed (VPS `srv1692698`, `ssh agent@100.82.195.109`, Tailscale only)** — `genesis-api` + `genesis-bot` + `genesis-web` all **active at `c2540ac`+ (docs commits since don't need redeploy)**. `/health` ok, `defaultEngine: interactive`. `/home/agent/workspace` exists (recreated). `GENESIS_PROJECTS_ROOT=/home/agent/workspace` is the clone allow-root.
- **Linear (Broomva; use `mcp__linear-server__*`):** **BRO-1635** epic (Session Launcher, Backlog) · **BRO-1629** In Progress (slice 5 = phase A) · **BRO-1636** phase B (launcher card, Backlog) · **BRO-1637** phase C (grouping, Backlog) · **BRO-1631** (vps guard, Backlog) · **BRO-1634** (composer testability, Backlog). BRO-1630 **Done**.
- **No running local dev daemons.** All prior validation was on the deployed VPS + `bun test`.

## What the prior arc delivered (so you don't redo it)

| PR | Merge SHA | What it gave |
|----|-----------|--------------|
| #75 | `b9587ad` | BRO-1630 RC1 durable `--resume` + RC2 actionable eviction (engine/session-host/reducer) |
| #76 | `c9623f9` | BRO-1630 RC3 / BRO-1629 **slice 4** — workspace reconciliation: dispatch guard on vanished cwd + `available` DTO + PWA badge/picker gating |
| #77 | `c2540ac` | fix-forward: RC3 guard broke 2 fake-path dispatch tests (evals harness + drizzle store) → `workspaceExists: () => true` bypass |

BRO-1630 is **reproduced + fixed + validated end-to-end** (engine PERSIMMON dogfood + real-phone UI FALCON-7 recall across a daemon restart, server-confirmed). Design spec for the launcher: `docs/specs/2026-07-01-session-launcher.html`.

## First action — BRO-1629 slice 5 (add-by-git-URL)

Build `POST /workspaces {gitUrl}`. Concrete steps:

1. Read `apps/api/src/workspace-provision.ts` — mirror `resolvePick`'s security spine (charset guard, `resolve()` + `realpathSync` allow-root boundary, `.git` check). Add `resolveGitUrl(allowRoot, gitUrl)`: **validate the URL** (allow only `https://` and `git://` public hosts; **block** `file://`, `ssh://`/scp-style with embedded creds, `localhost`/RFC-1918/link-local/metadata IPs — SSRF), derive a **server-side** target dir name from the repo slug inside the allow-root (client never names a path), then `git clone --depth 1 <url> <target>` (bounded timeout, `GIT_TERMINAL_PROMPT=0` so it can't hang on auth), then register via `FsWorkspaceRepository` + `supervisor.registerWorkspace` (idempotent-by-rootPath — already handles the dup case).
2. Wire `POST /workspaces` in `apps/api/src/server.ts` to branch on `{gitUrl}` vs `{pick}` (bearer-gated same as pick).
3. Web: `apps/web/lib/workspaces.ts` (`addWorkspaceByUrl`) + `apps/web/components/workspaces-manager.tsx` (a URL field beside discover→pick).
4. **Tests:** unit-test the URL validator hard (SSRF/credential/scheme rejections), the clone-then-register happy path (mock the clone), and the web passthrough. **Run the FULL suite** (`bun test`, all 42 files) + `bunx biome ci .` + `bunx turbo run typecheck` before push — see Lessons.
5. Branch `feat/workspace-add-by-git-url`; worktree optional (single-package-ish, but multi-file across api+web → a worktree is fine); P20 cross-review before merge; `p9`/CI watch; deploy = `git pull` + restart `genesis-api`/`genesis-bot` + rebuild `genesis-web`; then P11 dogfood the clone (create a public test repo → add by URL from the PWA → confirm it registers + is bindable).

*If blocked on URL-validation policy design,* the safe default is: `https://` only, host must be in an allowlist (`github.com`, `gitlab.com`, or an env-configured set), reject anything else with a clear 400 — tighten later.

## Pickup state (what's open, priority order)

- [ ] **BRO-1629 slice 5** — add-by-git-URL (first action above).
- [ ] **BRO-1636** — Session Launcher phase B (configurator card + root/worktree toggle + finish BRO-1622 engine gating).
- [ ] **BRO-1637** — Session Launcher phase C (sidebar grouping Workspaces/Worktrees/Sessions).
- [ ] **BRO-1631** — extend the RC3 workspace guard to `vps` ssh hosts (latent).
- [ ] **BRO-1634** — composer `data-testid`/E2E hook (build launcher with this from day one).

## Lessons (do not relearn these)

- **A cross-cutting Supervisor change needs the FULL `bun test` (all 42 files) pre-push, not just touched packages.** The RC3 guard passed core+api+web locally but broke `packages/evals` + `packages/db` dispatch tests → red main → #77 fix-forward. Any change touching `runTurn`/dispatch → run everything.
- **`biome ci` is stricter than `biome check`** — it errors on unsafe-fixable lints (`useTemplate` string-concatenation). Run `bunx biome ci .` locally before pushing.
- **CI merged over a red check** — genesis has **no required-status-check branch protection**. Confirm the run for the *exact head SHA* is `success` (`gh run list --branch <b> --json headSha,conclusion`) before merging, not just that a watcher exited 0. (Recommend enabling branch protection.)
- **Durable resume keeps the session id (CLI 2.1.191+)** — `--resume <id>` without `--fork-session` preserves the id + appends the transcript. Don't rebuild a re-keying handshake. (KG: `research/entities/pattern/claude-code-wrap-stability-ladder.md`.)
- **The React composer isn't headlessly drivable** (BRO-1634) — Interceptor can't reliably type into it (background tab + controlled input); UI validation was done on a real phone + at the engine layer. Build the launcher with stable test hooks.
- **Deploy mechanics:** engine = `git pull --ff-only && systemctl --user restart genesis-api genesis-bot` (TS from source via bun). Web = `cd apps/web && bun run build` (NO turbo `build` task — direct `next build`), then `cp -r .next/static .next/standalone/apps/web/.next/ && cp -r public .next/standalone/apps/web/`, then restart `genesis-web`. `export PATH="$HOME/.bun/bin:$PATH"` on the non-interactive SSH.

## Related context

- **Spec:** `docs/specs/2026-07-01-session-launcher.html` (launcher design + Omnara mapping + phasing) · `docs/specs/2026-07-01-fs-native-workspace-substrate.html` (the substrate north star; slice 5 = its 2.5b)
- **Linear:** BRO-1635 (epic) · BRO-1629 (slice 5) · BRO-1636/1637 (phases B/C) · BRO-1630 (Done, the resume fix) · parent BRO-1356 (greenfield epic)
- **Prior handoffs:** `docs/handoffs/2026-07-01-session-resume-fix.md` (BRO-1630 arc) · `docs/handoffs/2026-07-01-workspace-substrate-continuation.md` (slices 1–3)
- **Memory:** `srv1692698-agent-host` (VPS access), `genesis-workspace-selection`, `genesis-codex-engine`
- **KG:** `research/entities/tool/omnara.md` (the inspiration) · `research/entities/pattern/claude-code-wrap-stability-ladder.md`
- **Project CLAUDE.md:** `apps/genesis/CLAUDE.md` (3-tier: Next.js web → Hono engine → Supervisor → Store seam)
