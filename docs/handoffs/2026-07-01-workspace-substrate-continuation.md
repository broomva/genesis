# Genesis — continue improving after the FS-native workspace substrate arc (BRO-1629)

**TL;DR.** The FS-native, runtime-mutable, self-serve workspace substrate (BRO-1629) is fully merged, deployed to the VPS, and dogfooded end-to-end on web + mobile — the arc is *done and clean*. **First action:** pick up **slice 4 — the reconciliation controller** (GC a workspace manifest whose repo dir was `rm`'d out from under it), starting from `apps/api/src/workspace-repository-fs.ts` + `packages/core/src/supervisor.ts` `loadRegistry`/`refreshRegistry`.

---

## State of the world (P15 snapshot 2026-07-01)

- **`~/broomva/apps/genesis`** (repo `github.com/broomva/genesis`) — branch **`main`**, **clean tree, 0 ahead / 0 behind**, **0 open PRs**. HEAD `1ed750d`.
  - Recent: `1ed750d` (#74 idempotency) · `53d1b61` (#73 Add-project UI) · `d382294` (#72 CRUD) · `c2cec90` (#71 FS adapter) · `6fda379` (#70 port) · `c2ac05a` (#69 spec) · `d7b78a7` (#68 composer, prior arc).
- **Deployed engine + web (VPS `srv1692698`)** — **both `active`, at HEAD `1ed750d`** (matches main). Access: `ssh agent@100.82.195.109` (Tailscale only; public :22 closed — Mac needs Tailscale up). Served at `https://srv1692698-agent.tailf3e897.ts.net` (web :3000 → engine :8787).
  - Engine `/health`: `{ok:true, engines:["print","interactive","codex"], defaultEngine:"interactive"}`.
  - Live registry: `ws-default` + `ws-rust-cli` (clean; no test artifacts).
  - **Workspace-substrate env** (in `~/.config/genesis-bot/env.sh`, sourced by `start-api.sh`): `GENESIS_PROJECTS_ROOT=/home/agent/workspace` (allow-root for discover→pick AND boot auto-scan), `GENESIS_WORKSPACES_DIR=/home/agent/.config/genesis-bot/workspaces` (durable JSON manifests → `FsWorkspaceRepository`), `GENESIS_WORKSPACE=/home/agent/workspace`, `GENESIS_NO_WORKTREE=1`, engine=interactive, **no `GENESIS_TOKEN`** (engine open on tailnet; web BFF has `AGENT_TOKEN` for machine principal).
- **Linear** — **BRO-1629** *In Progress* (Broomva team `adb73ec0-08f5-45c1-ab1f-ef1ff8dc01ff`; use the `mcp__linear-server__*` MCP, NOT the CLI). A completion comment listing #69–#74 is posted. Parent lineage: BRO-1627 (env registry), BRO-1356 (greenfield epic).
- **No running local dev daemons** for this arc (all validation was on the deployed VPS + local `bun test`).

## What the BRO-1629 arc delivered (so the next agent doesn't redo it)

| PR | Merge SHA | Files | What it gave |
|----|-----------|-------|--------------|
| #69 | `c2ac05a` | `docs/specs/2026-07-01-fs-native-workspace-substrate.html` | Category-C spec (the north star) |
| #70 | `6fda379` | `packages/core/src/workspace-repository.ts`, `supervisor.ts`, `index.ts` | `WorkspaceRepository` port + `InMemoryWorkspaceRepository`; supervisor `workspaceRegistry` is now a **cache**; `registerWorkspace`/`removeWorkspace` runtime-mutable; `listWorkspaces()` async DTO (no `rootPath`) |
| #71 | `c2cec90` | `apps/api/src/workspace-repository-fs.ts` (+ test) | `FsWorkspaceRepository` — **manifest-in-git source of truth** (one `<id>.json` per ws, git-logged, opt-in `GENESIS_WORKSPACES_DIR`); durable across restart; pid-scoped temp+rename; `add -A -- .` bounded pathspec; `SAFE_ID` charset + startsWith backstop; `list()` skips id≠filename |
| #72 | `d382294` | `apps/api/src/workspace-provision.ts`, `server.ts`, `index.ts` (+ tests) | discover→pick CRUD: `GET /workspaces/available`, `POST /workspaces {pick}`, `DELETE /workspaces/:id` (bearer-gated). **Security spine: client names a directory NAME; server derives+validates `rootPath` inside the allow-root** (charset, no traversal, lexical + **realpath** boundary, `.git` check). Forge P20 8/10 (SF1 symlink-escape, SF2 error-split, SF3 open-verb warning, N1/N2) |
| #73 | `53d1b61` | `apps/web/app/api/workspaces/{route,available/route,[id]/route}.ts`, `lib/workspaces.ts`, `components/workspaces-manager.tsx`, `components/settings-sheet.tsx`, `app/page.tsx` (+ tests) | PWA "Add project" UI — settings-sheet "Projects" section (list registered, remove any but default, one-tap add of discoverable repos). BFF routes all `authorizePrincipal`-gated. Forge 8/10 (S1/S2/N1/N2) + CodeRabbit Major (empty-id guard) |
| #74 | `1ed750d` | `packages/core/src/supervisor.ts` (+ test) | **idempotent-by-rootPath** `registerWorkspace` — a P11 dogfood caught a dup both review models reasoned around |

**Both original user complaints resolved:** restart-required → runtime-mutable (POST/DELETE, no reboot); can't-drive-from-PWA → settings-sheet Projects manager.

## E2E proof (re-runnable any time the VPS is up)

```bash
# 1. Engine health + live registry
ssh agent@100.82.195.109 'curl -s http://127.0.0.1:8787/health; echo; \
  curl -s http://127.0.0.1:8787/workspaces'
# Expected: ok:true; workspaces = ws-default + ws-rust-cli

# 2. Full discover→add→idempotency→remove cycle (no restart between)
ssh agent@100.82.195.109 '
  B=http://127.0.0.1:8787
  mkdir -p /home/agent/workspace/demo && cd /home/agent/workspace/demo && \
    git init -q -b main && git -c user.email=a@b.c -c user.name=x commit -q --allow-empty -m init
  curl -s $B/workspaces/available                                  # -> {"available":[{"name":"demo",...}]}
  curl -s -X POST $B/workspaces -H "content-type: application/json" -d "{\"pick\":\"demo\"}"   # -> ws-demo
  curl -s -X POST $B/workspaces -H "content-type: application/json" -d "{\"pick\":\"demo\"}"   # -> ws-demo AGAIN (idempotent, no -hash dup)
  curl -s $B/workspaces | python3 -c "import sys,json;print(sum(1 for w in json.load(sys.stdin)[\"workspaces\"] if \"demo\" in w[\"id\"]))"  # -> 1
  curl -s -X POST $B/workspaces -H "content-type: application/json" -d "{\"pick\":\"../etc\"}" -o /dev/null -w "%{http_code}\n"  # -> 400
  curl -s -X DELETE $B/workspaces/ws-demo -o /dev/null -w "%{http_code}\n"   # -> 200
  rm -rf /home/agent/workspace/demo'

# 3. Web BFF auth gate (machine principal)
ssh agent@100.82.195.109 'T=$(grep ^AGENT_TOKEN= ~/.config/genesis-web/secrets.env|cut -d= -f2-|tr -d "\"")
  curl -s -o /dev/null -w "no-auth:%{http_code}\n" http://127.0.0.1:3000/api/workspaces          # -> 401
  curl -s -o /dev/null -w "auth:%{http_code}\n" -H "X-Agent-Token: $T" http://127.0.0.1:3000/api/workspaces'  # -> 200
```

Local test suite: `cd ~/broomva/apps/genesis && bun test apps/api packages/core apps/web` (≈203 tests, all green). `next build` in `apps/web` must stay clean (SSR-prerender is a historical white-screen trap — see Lessons).

## First action

**Design + implement slice 4 — the reconciliation controller.** The gap: if a repo dir is deleted out-of-band (`rm -rf /home/agent/workspace/foo`), its manifest `foo.json` persists → the workspace still lists + is bindable → a thread bound to it fails at agent-cwd time. There is no GC.

Concrete start:
1. Read `apps/api/src/workspace-repository-fs.ts` (the manifest store) and `packages/core/src/supervisor.ts` `loadRegistry()` (lines ~245–275) + `refreshRegistry()`.
2. Add a **reconcile pass**: on boot (`loadRegistry`) and optionally on a cadence, for each manifest whose `rootPath` no longer exists (or is no longer a git repo), mark it **unavailable** (soft — a new field, hidden from `listWorkspaces()` DTO + `/available`) rather than hard-deleting (a transient unmount ≠ a delete; align with the spec's "mark vanished paths unavailable, don't destroy"). Hard-GC only on explicit user remove.
3. This is the "desired vs observed" controller the spec (`docs/specs/2026-07-01-fs-native-workspace-substrate.html`) describes as slice 2.5c-tail. Keep the security spine intact (server-only `rootPath`).
4. File a Linear sub-issue under BRO-1629 (`mcp__linear-server__*`, Broomva team), branch `feat/workspace-reconciliation`, then run the standard /autonomous pipeline (worktree optional — single-package likely; P20 cross-review before merge; P9 CI watch; deploy engine = pull + `systemctl --user restart genesis-api`).

*If blocked on reconciliation design,* fall back to **slice 5** (add-by-git-URL: `POST /workspaces {gitUrl}` → server clones into the allow-root then registers — lines up with the microVM `GENESIS_GIT_URL` model) which is more self-contained.

## Pickup state (what's open)

- [ ] **Slice 4 — reconciliation controller** (first action above). The one real robustness gap.
- [ ] **Slice 5 — add-by-git-URL clone** (`POST /workspaces {gitUrl}`) + **ownerId scoping** (multi-user isolation; `workspaces` has no owner today so the list is global; better-auth is already wired).
- [ ] **Minor (optional):** browser HTTP-cache on `GET /api/workspaces/available` — verify the dynamic route sends `no-store` so a post-add/remove refetch never serves stale candidates (round-trip worked in dogfood, so low priority; confirm headers if touching this area).

## Lessons (do not relearn these)

- **P11 dogfood caught a dup that BOTH Forge (P20) and CodeRabbit missed** — they shared the unstated "exactly-once submission" premise, so two review models added *signatures, not independence*. Only interacting with the deployed artifact (a double-fire tap) falsified it. **P11 and P20 are complementary, not redundant** — cross-*vendor* buys independence against model-family errors but NOT against a premise both models inherit from the code's own framing. (KG: `research/entities/concept/evidentiary-independence-conservation.md`, first-party instance appended 2026-06-30.)
- **`GENESIS_PROJECTS_ROOT` does double duty** (boot auto-registers every git repo under it, AND is the discover→pick allow-root). So `/workspaces/available` is **empty right after boot** — it surfaces repos that appear *later* (created/cloned post-boot). This looks like a bug but is intended.
- **Interceptor dogfooding gotchas (Genesis, mobile):** (1) use **Interceptor CLI** (`interceptor ...` via Bash), NOT claude-in-chrome (user preference). (2) After any server-side change, **`interceptor eval --main 'location.reload()'`** to clear stale React state + browser HTTP-cache before inspecting — a stale open sheet will show old data and *look* like a bug. (3) **Screenshots are WS-flaky → use `read --tree-only` + `eval --main` computed-styles/DOM** as evidence (stronger than pixels anyway). (4) **Chrome clamps window width to ~556px min**; a true 390px phone viewport needs CDP device emulation (claude-in-chrome) — so mobile was tested at 500px inner (still < 640 breakpoint → full-width sheet). (5) **Multiple same-URL tabs confuse routing** — `interceptor tab switch <id>` + `eval 'innerWidth'` to confirm which window a tab is in before driving it. (See memory `interceptor-react-input-double-submit`, `genesis-workspace-selection`.)
- **Deploy mechanics:** engine (`apps/api`, `packages/core`) runs TS from source via `bun` → deploy = `cd ~/genesis && git pull --ff-only && systemctl --user restart genesis-api`. Web (`apps/web`) → `export PATH="$HOME/.bun/bin:$PATH"; bun run build` on the VPS, then **copy `.next/static` + `public` into `.next/standalone/apps/web/`**, then `systemctl --user restart genesis-web` (standalone server: `node server.js`). `bun` is NOT on the non-interactive SSH PATH — export it.
- **`useSession` is not SSR-safe** (breaks `next build` prerender → white-screen) — render auth identity client-only via `<ClientOnly>` (memory `genesis-settings-and-usesession-ssr`).

## Related context

- **Spec:** `apps/genesis/docs/specs/2026-07-01-fs-native-workspace-substrate.html` (the north star — slices 4/5 map to its 2.5c-tail / 2.5b / 2.5d)
- **Linear:** BRO-1629 (In Progress, Broomva) · parent BRO-1627 (env registry), BRO-1356 (greenfield epic)
- **Memory:** `genesis-workspace-selection` (the arc's full record + gotchas), `srv1692698-agent-host` (VPS access), `genesis-codex-engine`, `genesis-settings-and-usesession-ssr`, `interceptor-react-input-double-submit`
- **KG:** `research/entities/concept/evidentiary-independence-conservation.md` · `research/entities/project/genesis.md`
- **Project CLAUDE.md:** `apps/genesis/CLAUDE.md` (3-tier architecture: Next.js web → Hono engine → Supervisor → Store seam)
