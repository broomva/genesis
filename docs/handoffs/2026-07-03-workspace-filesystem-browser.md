# Handoff — Workspace Filesystem + Git Browser (BRO-1666)

**Date:** 2026-07-03 · **From:** long session (Session Launcher arc) · **Ticket:** BRO-1666
**Goal:** a button in the chat header's right group opens a slide-over that browses the
active thread's workspace — a mobile git client: **Repo Files** (tree + view file) ·
**Changes** (git status + diff) · **Checks** (CI) · Commit & Push.

The user's reference screenshots (2026-07-03) show a mobile panel with tabs
`Git / Preview / Scripts / Settings`, and under Git: `Changes / Repo Files / Checks / Connect`.
Changes lists `U`(untracked)/`+N -N`(modified) per file with "Compare against: origin/main"
+ a **Commit & Push** button + branch chip. Repo Files is a file tree of the workspace root
(the screenshot is the **broomva** workspace: `.cache .claude .control docs crm packages
roles schemas …`). Build toward that; ship in read-only slices first.

---

## Start here (first 5 minutes)

1. `cd ~/broomva/apps/genesis` (its own git repo; NOT the parent `~/broomva`).
2. **P15 snapshot:** `git status` · `git log --oneline -3` · `gh pr list`. As of handoff:
   `main @8e98fcb`, clean, **0 open PRs**, VPS deployed + healthy.
3. Claim **BRO-1666** in Linear (`mcp__linear-server__*`, Broomva team
   `adb73ec0-08f5-45c1-ab1f-ef1ff8dc01ff` — NOT the CLI, NOT the Stimulus connector).
4. Branch `feat/bro-1666-repo-files` off clean main. In-place (single-agent); not a worktree.
5. Build **Slice 1 (Repo Files)** end-to-end, then PR → CI → CodeRabbit → merge → deploy → dogfood.

---

## Current state (what this session already shipped — don't re-do)

All merged + deployed + dogfooded on VPS `srv1692698` (Tailscale-only, `ssh agent@100.82.195.109`):

| Feature | Ticket / PR |
|---|---|
| Per-session root/worktree binding | BRO-1656 / #83 |
| Session Launcher card + root/worktree toggle | BRO-1657 / #84 |
| Deploy footgun fix — standalone static copy baked into `build` | BRO-1659 / #85 |
| Header = session name + `workspace · branch` subtitle; composer decluttered | BRO-1662 / #86,#87 |
| Add-workspace-by-path (owner-only, P20 security 9/10) | BRO-1663 / #88 |
| Literal git branch in the header (`broomva · main`) | BRO-1664 / #89 |
| LLM-generated session titles (async, atomic, P20 8/10) | BRO-1665 / #90 |

`broomva` is registered as a workspace on the VPS (`ws-broomva` → `/home/agent/broomva`,
`noWorktree:true` → runs at root). Manifest: `~/.config/genesis-bot/workspaces/ws-broomva.json`.

---

## Architecture you need (Genesis)

- **Web PWA** `apps/web` (Next 16 standalone) → **BFF** (`apps/web/app/api/*/route.ts`,
  auth-gated, proxies to the engine, **strips filesystem paths**) → **engine** `apps/api`
  (Hono, `:8787`, localhost/tailnet-only; no `GENESIS_TOKEN` on the VPS → open on localhost)
  → **`@genesis/core`** Supervisor → **`@genesis/db`** (drizzle + pglite).
- **Workspaces** (`apps/api/src/workspaces.ts`, `workspace-provision.ts`,
  `workspace-repository-fs.ts`): a registry of `{id, name, rootPath, isGitRepo?, noWorktree?}`.
  The **`rootPath` is server-only and NEVER leaves the engine** (the public DTO omits it —
  see `Supervisor.listWorkspaces`). This is a hard invariant; the fs browser must honor it.
- **cwd resolution:** `supervisor.workspaceRegistry.get(workspaceId)?.rootPath`. A thread's
  *effective* cwd depends on its `noWorktree` posture (root vs a `.genesis-runs/session-*`
  worktree) — for the browser, browsing the workspace **root** is the sensible default
  (worktrees are transient per-run). On the VPS everything is root anyway (`GENESIS_NO_WORKTREE=1`).
- **Running git / fs:** the engine runs on the box; use the **host abstraction**
  `lease.host.exec(["git", …], { cwd: rootPath })` (see `packages/runner/src/index.ts:108,212`)
  so it stays host-agnostic (LocalHost/VpsHost/microVM). Node `fs` in `apps/api` also works for
  LocalHost, but prefer `host.exec` / a host `readFile` for portability.

---

## Slice 1 — Repo Files (read-only tree). Ship this first.

**Server (`apps/api`)** — two new routes on the workspace, path-sandboxed:
- `GET /workspaces/:id/files?path=<relative>` → `{ entries: [{ name, type: "dir"|"file", size? }] }`
  for the dir at `<relative>` under the workspace root (default: root). RELATIVE names only.
- `GET /workspaces/:id/file?path=<relative>` → `{ content, truncated }` (cap ~256 KB; refuse
  binary or return a flag). RELATIVE path in, contents out.
- **Sandbox (critical, mirror BRO-1663 `resolvePathAdd`):** resolve `rootPath + path`, then
  `realpathSync` and assert it's still under `realpathSync(rootPath)` (reject `..`, symlink
  escapes, absolute paths). Reject `.git/` internals if you want (optional). NEVER return the
  absolute path — only the relative path + contents. Errors are safe/generic (no path leak).
- Respect `.gitignore`? Not required for v1; a plain dir listing is fine (the screenshot shows
  `.cache`/`.claude` etc., i.e. NOT gitignore-filtered). Sort dirs-first, then files.

**BFF (`apps/web/app/api/…`)** — passthrough via `proxyGenesisGetJson` (see
`apps/web/lib/genesis-proxy.ts`), same auth gate as `/api/threads`
(`authorizePrincipal`). Reads are fine for the agent principal; **writes (Slice 3) are owner-only**.

**Client:**
- `apps/web/lib/files.ts` (new) — `fetchDir(wsId, path)`, `fetchFile(wsId, path)`.
- `apps/web/components/workspace-browser.tsx` (new) — a Radix Dialog **slide-over**; clone the
  structure of `apps/web/components/settings-sheet.tsx` (overlay + right-anchored `Content` +
  tabs). Tabs: `Repo Files` (Slice 1), stub `Changes`/`Checks` for later.
- File tree: recursive, **lazy** (fetch a dir's children on expand). Tap a file → fetch + show
  contents (a simple `<pre>`/streamdown code view; reuse `streamdown` if you want highlighting).
- Header button: in `apps/web/components/chat-view.tsx`, the header right group
  (search `RunSignal mode` — the `<div className="flex shrink-0 items-center gap-2">` with
  `RunSignal` + `ThemeToggle`). Add a `FolderTree`/`FolderGit2` icon button before ThemeToggle.
  Wire open state in `apps/web/app/page.tsx` exactly like `settingsOpen`/`onOpenSettings`
  (state + `onOpen…` prop passed into ChatView; render `<WorkspaceBrowser>` beside `<SettingsSheet>`).
- Which workspace: the active thread's bound workspace id (`activeThread?.workspaceId`), else the
  selected `workspace` (page.tsx already resolves `activeWorkspace`). Pass the id down.
- `data-testid`s on the button + panel + tree rows (BRO-1634 discipline) for E2E.

**Tests:** the sandbox resolver is the security core — unit-test it like
`workspace-provision.test.ts` did for `resolvePathAdd` (accept in-root, reject `..`/symlink-escape/
absolute/outside). Client: `files.ts` fetch shape + a tree-render smoke test.

## Slice 2 — Changes (git status + diff)
`GET /workspaces/:id/git/status` → parse `git status --porcelain=v1 -uall` into a tree with
per-file status (`U`/`M`/`A`/`D`) + optional `+N -N` from `git diff --numstat`. `GET
/workspaces/:id/git/diff?path=` → `git diff -- <path>` (and `--cached` variant). All via
`host.exec(["git",…], {cwd: rootPath})`. Read-only. "Compare against origin/main" = a base param.

## Slice 3 — Commit & Push (OWNER-ONLY — mandatory P20)
Stage/commit/push is a write op that runs git in the user's repo. **Owner-gate at the BFF**
(reject the agent principal, exactly like BRO-1663's `{path}` gate in
`apps/web/app/api/workspaces/route.ts`). Validate the commit message; never accept arbitrary
git args from the client. Fire a P20 security subagent before merge.

## Slice 4 — Checks / Preview / Scripts / Connect (deferred)
CI status via `gh`, `package.json` scripts runner, app preview, GitHub OAuth connect. Scope later.

---

## Conventions + gotchas (bstack)

- **Toolchain:** `bun` (not npm), `biome` (not eslint). Gate = `bun test` + `bunx biome ci .` +
  `bunx turbo run typecheck`. `next build` must pass (it also runs the standalone static copy).
- **Deploy (VPS):** `ssh agent@100.82.195.109 'cd ~/genesis && git pull --ff-only && cd apps/web
  && bun run build && cd ~/genesis && systemctl --user restart genesis-api genesis-bot genesis-web'`.
  Server-only change → restart api+bot; web change → also rebuild + restart genesis-web.
  **Always verify a `/_next/static/*` ASSET returns 200 after deploy** (not just the HTML) — an
  HTML-200 with 404 assets = blank page (the BRO-1659 footgun; the copy is now automated in
  `build`, but keep the check). DB migrations run on boot via `MIGRATE_SQL` (ADD COLUMN IF NOT EXISTS).
- **Dogfood pattern:** the engine is open on `127.0.0.1:8787` on the box — curl the new routes
  directly (e.g. `GET /workspaces/ws-broomva/files?path=`). For the UI, the local **Chrome can't
  resolve the `*.ts.net` MagicDNS name** (secure-DNS/DoH) — use the **iPhone** (native MagicDNS) or
  add `/etc/hosts 100.82.195.109 srv1692698-agent.tailf3e897.ts.net` (needs sudo). Prove the
  client shipped by grepping the built bundle on the box:
  `ssh … 'grep -rl workspace-browser ~/genesis/apps/web/.next/static'`.
- **P20:** any security-sensitive slice (Slice 3 writes; the Slice 1 path sandbox) → fire a
  fresh-context adversarial subagent (`Agent`, general-purpose, devil's-advocate brief) before merge.
- **Every PR:** Linear ticket → branch → PR (HEREDOC body, test plan) → `gh run watch --background`
  → address CodeRabbit threads (resolve to 0) → merge → deploy → dogfood → janitor (clean tree).
- **Never** copy `crm/` content (PII) into public repos/posts. `broomva` workspace contains
  `crm/`, `freelance/`, `personal/` — the fs browser will surface them to the owner (fine, their
  box) but the AGENT must never exfiltrate that content.

## Key files (anchors)
- Header + open-state trigger: `apps/web/components/chat-view.tsx` (right group) + `apps/web/app/page.tsx`.
- Slide-over pattern to clone: `apps/web/components/settings-sheet.tsx`.
- Path-sandbox reference: `apps/api/src/workspace-provision.ts` (`resolvePathAdd`, `pathAddRoots`).
- Workspace routes today: `apps/api/src/server.ts` (`GET /workspaces`, `POST /workspaces`, …).
- rootPath source: `packages/core/src/supervisor.ts` (`workspaceRegistry`, `listWorkspaces` DTO).
- BFF proxy: `apps/web/lib/genesis-proxy.ts`; auth: `apps/web/lib/api-auth.ts` (`authorizePrincipal`, `asAgent`).
- Host git exec examples: `packages/runner/src/index.ts:108,212,218`.
