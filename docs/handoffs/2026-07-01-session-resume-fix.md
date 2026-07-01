# Genesis — after the session-resume/amnesia fix (BRO-1630) + workspace reconciliation (BRO-1629 slice 4)

**TL;DR.** A mobile-PWA incident (blank fresh agent on resume + silent `(no output)`) was diagnosed to **3 root causes**, all fixed across **PRs #75/#76/#77**, merged to `main`, deployed to the VPS, and **dogfood-proven live** (context recalled across a real daemon restart). The FS-native workspace substrate now has its reconciliation controller (slice 4). **First action:** pick up **BRO-1629 slice 5 — add-by-git-URL** (`POST /workspaces {gitUrl}` → server clones into the allow-root then registers), the task that was preempted by this incident.

---

## State of the world (P15 snapshot 2026-07-01)

- **`~/broomva/apps/genesis`** (repo `github.com/broomva/genesis`) — branch **`main`**, **clean tree, 0/0 with origin**, **0 open PRs**, no worktrees. HEAD **`c2540ac`**.
  - `c2540ac` (#77 fix-forward) · `c9623f9` (#76 RC3/slice-4) · `b9587ad` (#75 RC1+RC2) · `4772284` (prior handoff) · `1ed750d` (#74).
- **Deployed (VPS `srv1692698`, `ssh agent@100.82.195.109`, Tailscale only)** — `genesis-api` + `genesis-bot` + `genesis-web` all **active at HEAD `c2540ac`**.
  - Engine `/health`: `{ok:true, engines:["print","interactive","codex"], defaultEngine:"interactive"}`.
  - `/workspaces` → `ws-default` (name `genesis`) with **`available:true`** (RC3 DTO field live). Web BFF `/api/workspaces` returns it too.
  - **`/home/agent/workspace` recreated** (was deleted out-of-band — RC3's real-world trigger).
- **Linear** — **BRO-1630 Done** (Urgent; resolution comment posted). **BRO-1629 In Progress** (slice 4 shipped; slice 5 + 2.5d open). **BRO-1631 Backlog** (vps-host guard follow-up). Broomva team; use `mcp__linear-server__*`.

## What this arc delivered

| PR | Merge SHA | What it gave |
|----|-----------|--------------|
| #75 | `b9587ad` | **RC1 durable resume** — the interactive engine now respawns `claude --resume <priorId>` when the thread's transcript is on disk (survives daemon restart / eviction / idle-kill), instead of ignoring `resumeSessionId` and starting blank. **RC2** — a send-eviction / turn-timeout returns an actionable reply, not silent `(no output)`; reducer surfaces an error result's `result` as `lastText`. + resume-reversion alarm in the hub. 185 tests, P20 7/10. |
| #76 | `c9623f9` | **RC3 / BRO-1629 slice 4** — `runTurn` refuses to dispatch into a vanished `rootPath` (local hosts; error names the workspace, never the path) with a phantom-`running`-safe catch; `listWorkspaces()` computes `available`; PWA manager badges + composer picker disables unavailable workspaces; deduped boot warn. P20 7/10 (caught + fixed a real phantom-running bug). |
| #77 | `c2540ac` | Fix-forward: the cross-cutting guard broke 2 fake-path dispatch tests (evals harness + drizzle store) → inject `workspaceExists: () => true`. Full suite 502 pass / 1 skip / 0 fail. |

## The load-bearing finding (retires BRO-1485 #2)

On **CLI 2.1.191/197**, `claude --resume <id>` **without** `--fork-session` **keeps the same session_id and appends to the same `<id>.jsonl`** (verified live twice: transcript grew 9→15 lines, no new file; `--session-id A --resume A` errors). The old reason resume was removed ("resume reassigns the id → breaks hub routing") is **stale**. So durable resume needs **no re-keying handshake** — just spawn `--resume <priorId>` and omit `--session-id`. `claude --resume <id> "<prompt>"` also runs the trailing positional prompt (arg-parsing verified).

## Dogfood proof (re-runnable; the reported bug)

```bash
ssh agent@100.82.195.109 '
  B=http://127.0.0.1:8787; T=dogfood-$(date +%s)
  curl -s -X POST $B/message -H "content-type: application/json" \
    -d "{\"threadId\":\"$T\",\"text\":\"Remember: PERSIMMON. Reply OK\"}" --max-time 220
  systemctl --user restart genesis-api; sleep 4        # wipe the in-memory live session
  curl -s -X POST $B/message -H "content-type: application/json" \
    -d "{\"threadId\":\"$T\",\"text\":\"What was the secret word? Reply only the word.\"}" --max-time 220'
# Turn 2 → reply "PERSIMMON", phase done, SAME sessionId as turn 1 (resumed, not blank)
```

## First action

**BRO-1629 slice 5 — add-by-git-URL.** `POST /workspaces {gitUrl}` → server validates the URL (block `file://`, credentialed ssh, SSRF hosts), clones into the `GENESIS_PROJECTS_ROOT` allow-root, then registers via `FsWorkspaceRepository` + `supervisor.registerWorkspace` (idempotent-by-rootPath). Files: `apps/api/src/workspace-provision.ts` + `server.ts`, `apps/web/{lib/workspaces.ts, components/workspaces-manager.tsx}`. Security spine unchanged: client never names a path. Branch `feat/workspace-add-by-git-url`; P20 before merge; **run the FULL `bun test` (not just touched packages) pre-push** (see Lessons).

## Pickup state (what's open)

- [ ] **BRO-1629 slice 5 — add-by-git-URL clone** (first action).
- [ ] **BRO-1629 2.5d — ownerId scoping** (multi-user isolation; list is global today).
- [ ] **BRO-1631 — extend the workspace guard to `vps` ssh hosts** (remote `test -d`; latent until VpsHost is wired).
- [ ] **RC2 deeper HITL hardening** (optional) — the post-`awaiting` send still hits the raw AskUserQuestion TUI dialog; route it through the question-card contract. RC1+error-surfacing already stop the silent drop + preserve context on resend.
- [ ] **Process gap** — the genesis repo has **no required-status-check branch protection**, so a red build merged (#76) before the #77 fix-forward. Recommend enabling required `test` check on `main`.

## Lessons (do not relearn these)

- **A cross-cutting Supervisor guard must be validated with the FULL `bun test`, not just touched packages.** The RC3 guard passed core+api+web locally but broke `packages/evals` + `packages/db` dispatch tests (fake rootPaths) → red main → #77 fix-forward. Run `bun test` (all 42 files) before pushing anything that touches `runTurn`.
- **CI merged over a red check** because genesis has no branch protection. `gh pr merge` succeeds regardless; confirm the run for the *exact head SHA* is `success` (`gh run list --branch <b> --json headSha,conclusion`) before merging, not just that a watcher exited.
- **`biome ci` is stricter than `biome check`** — it errors on unsafe-fixable lints (e.g. `useTemplate` string-concatenation). Run `bunx biome ci .` locally before pushing; `biome check --write` won't apply unsafe fixes.
- **Durable resume keeps the session id (CLI 2.1.191+)** — see the finding above. Don't rebuild the re-keying handshake.
- **Deploy mechanics:** engine = `cd ~/genesis && git pull --ff-only && systemctl --user restart genesis-api genesis-bot` (TS from source via bun). Web = `cd ~/genesis/apps/web && bun run build` (NO turbo `build` task — direct `next build`), then `cp -r .next/static .next/standalone/apps/web/.next/ && cp -r public .next/standalone/apps/web/`, then `systemctl --user restart genesis-web`. `bun` is not on the non-interactive SSH PATH — `export PATH="$HOME/.bun/bin:$PATH"`.

## Related context

- **Linear:** BRO-1630 (Done) · BRO-1629 (In Progress) · BRO-1631 (Backlog) · parent BRO-1356 (greenfield epic)
- **Prior handoff:** `docs/handoffs/2026-07-01-workspace-substrate-continuation.md` (the BRO-1629 slice 1–3 arc)
- **Memory:** `srv1692698-agent-host` (VPS access), `genesis-workspace-selection`, `genesis-codex-engine`, `interceptor-react-input-double-submit`
- **Project CLAUDE.md:** `apps/genesis/CLAUDE.md` (3-tier: Next.js web → Hono engine → Supervisor → Store seam)
