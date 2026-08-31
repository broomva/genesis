# AGENTS.md — broomva/genesis

Conventions an agent working here has to inherit. Each entry names the file and symbol
that constrains it, and says whether a test enforces it — because an invariant nothing
checks is a wish, and writing one down as though it were checked is worse than omitting
it.

Every claim below was verified against source on 2026-08-31. Two did not survive; they are
recorded as **NOT ENFORCED** rather than repeated.

---

## The voice surface (BRO-2228)

### Configuration gates route *registration*, not just authorization

`build()` (`apps/api/src/server.ts:156`) registers `POST /voice/identify` (`:271`) and
`POST /voice/request` (`:331`) **only inside `if (opts.voiceSecret)`** (`:253`). Omit the
secret and the routes do not exist — an unconfigured deploy 404s rather than exposing an
open intake.

This exists because a build once shipped an intake surface no caller could reach while 25
tests passed against it. `apps/api/src/index.ts:302-306` is the switch that turns it on;
without those lines the guard never ran and the routes were absent from every real deploy,
however green the injected-option tests were.

**Enforced:** `server.test.ts:124` ("WITHOUT a configured secret the routes do not exist
(404, not open)"), plus `index-wiring.test.ts`, which asserts against `index.ts` *source*
rather than against injected options — that is the test that would have caught the original
failure.

> Deleting the guard would not open the routes: `secretMatches` (`voice.ts:45-51`) returns
> false for an unset secret, so the fallback is 401, not 200. The guard buys 404-vs-401,
> which is the difference between "no such surface" and "a surface you guessed wrong at".

### A configured secret without a sink throws at construction

`build()` throws if `opts.voiceSecret` is set without `opts.enqueueVoice`
(`server.ts:258-263`). A configured channel with no sink used to answer 200 + "I'll follow
up" while storing nothing, because the sink was optional-chained away. That is a
misconfiguration, not a runtime condition.

**Enforced:** `server.test.ts:315`.

> **"At construction", not "at compile time".** `voiceSecret?` and `enqueueVoice?` are
> independently optional in `BuildOpts` — there is no discriminated union or overload, so
> `tsc` accepts `{ voiceSecret }` alone. The enforcement is a runtime `throw` during
> `build()`, before any request is served. Do not go looking for a type-level mechanism.

### The voice queue propagates write failures — deliberately, unlike `printTrace`

The closure returned by `createVoiceQueue` (`apps/api/src/voice-queue.ts:96-103`) wraps
`appendFileSync` in **no try/catch**, so a failed enqueue reaches `POST /voice/request` and
becomes a 503 the agent reads back to the caller. Never a 200 for a ticket that was
dropped. This is the opposite of `printTrace`'s swallow-and-continue policy, and the
difference is intentional: a dropped ticket is a request the caller was *told* was
recorded.

**Enforced:** `voice-queue.test.ts:129` plus a route-level test.

> Propagation covers write **errors**, not durability. `voice-queue.ts:61-71` concedes
> in-source that `appendFileSync` returns once the write reaches the page cache, so a host
> or power loss can still lose a ticket. That is acceptable only while the route promises
> no follow-up and Genesis runs a single process. **The change that adds a queue-draining
> consumer must add an fsync.**

### Nothing on the call path runs an agent

`POST /voice/identify` and `POST /voice/request` may call only `secretMatches`,
`readCallerId`, `resolveCaller` and `buildTicket` (`apps/api/src/voice.ts`), plus the
`enqueueVoice` sink whose sole production binding is `createVoiceQueue` — one
`appendFileSync`. Nothing reachable from a route handler spawns a session, an LLM call, or
a subprocess.

**NOT ENFORCED — no test asserts this.** It holds today by inspection of the call chain.
If you add anything to a voice route, this is the property to re-check by hand.

> The companion claim that "the 9–30s turn is physics" is **deliberately not stated here**.
> It rests on one prose measurement in a header comment with no committed script that
> regenerates it, and it is a claim about Claude Code rather than about this repository.
> Treat the latency wall as real and unmeasured, per BRO-2390.

### `normalizeCallerId` is duplicated, and the drift guard does not guard drift

`normalizeCallerId` (`apps/api/src/voice.ts:32`) and `normalizePhone`
(`apps/chat-bot/src/allowlist.ts:50`) are two hand-copies of one rule,
`value.replace(/\D/g, "")`. If they diverge, a caller whose number **is** allowlisted
resolves as `unknown` and silently drops to take-a-message, with nothing reporting it.

**NOT ENFORCED, despite appearances.** The test named `DRIFT GUARD` at
`apps/api/src/voice.test.ts:52` **re-declares the rule inline** —
`const allowlistRule = (v: string) => v.replace(/\D/g, "")` — and never imports or reads
`allowlist.ts`. A change to `normalizePhone` cannot fail it. There is no reciprocal guard
in `allowlist.test.ts` either.

`voice.ts:31`'s own comment says "see the drift test", so the false confidence is already
in the codebase. **Do not trust it.** Tracked as BRO-2409; the fix shape this repo already
uses for the same problem is the `readFileSync` + regex comparison at
`voice-queue.test.ts:279` (`HANDLED_FILE`), because `normalizePhone` is module-private and
cannot be imported.

---

## The host seam

`ExecutionHost` (`packages/host/src/index.ts:61`) is the interface an agent turn reaches a
host through — `exec` / `spawnStream` / `readFile` / `writeFile`, resolved per session by a
`HostProvider` (`host-provider.ts:25`). `LocalHost` and `VpsHost` declare
`credentialTier: "subscription"`; `VercelSandboxHost` declares `"keyed"`.

**Two parts of the usual framing are NOT true, and matter (BRO-2409):**

- **`credentialTier` is declarative and inert.** The interface is not a discriminated
  union, so nothing type-level stops `kind: "microvm"` + `credentialTier: "subscription"`.
  There are **zero production reads**: `aiGatewayEnv()` (`sandbox-provider.ts:17`) is a
  free function whose output the caller passes as `opts.env`, gated on nothing. Deleting
  the field would break exactly one test assertion. **Do not assume a keyed host cannot
  receive subscription OAuth — no code checks that.**
- **"Never reach past the seam" is aspirational.** Shipped code bypasses it and says so:
  `apps/api/src/workspace-git.ts:15-17` and `packages/core/src/supervisor.ts:590-593` both
  name the bypass and the intended migration to `host.exec`. Both are deliberate and
  guarded on local.

What remains true and worth keeping: **new host work should go through `ExecutionHost`**,
and adding a second seam needs an argument, not a convenience.

---

## CI, and what "tests pass" means

`.github/workflows/ci.yml` is a **single sequential job**, bun pinned to `1.3.14` (matching
`package.json`'s `packageManager`):

```
bun install --frozen-lockfile → bunx biome ci . → bun run typecheck → bun test
```

**Steps carry an implicit `success()` guard, so a failure at `biome ci` leaves typecheck
and test unmeasured.** A red run localises to the first failing step only; the later gates
are not green, they are unrun. Check `.steps[].conclusion` rather than the badge.

**The last step is bare `bun test` from the repo root, which is not the same set as
`bun run test`.** Measured 2026-08-31, both green:

| Invocation | Tests | Files |
| -- | -- | -- |
| `bun test` (what CI runs) | 1614 | 87 |
| `bun run test` → `turbo run test` | 1027 | 52 |

The 587-test delta is the root-level suites turbo's per-package tasks never reach. Neither
is wrong, but "tests pass" means whichever one you ran — and CI runs the larger set.

Known gaps, tracked in BRO-2407: no `permissions:` block, actions pinned to mutable major
tags rather than commit SHAs, no `concurrency` group, no branch protection on `main`, and
`bun install --frozen-lockfile` passes when no lockfile exists at all. The sibling repo
`broomva/walkie` has a worked example of the alternative shape.

---

## Toolchain

bun `1.3.14`, not npm or yarn · Biome `^1.9.4`, not ESLint or Prettier · Better Auth, not
NextAuth. Workspaces are `packages/*` and `apps/*`; `turbo` drives per-package tasks.

`biome.json` sets `vcs.useIgnoreFile: true`, so **biome hard-fails outside a git
repository** — relevant if a step ever copies files to a temp directory before checking
them.

---

## walkie

The voice control layer over these routes. **Four of its five build steps are Genesis-side
work**, which is the single most likely way to send an agent at the wrong tree:

| Step | Repo |
| -- | -- |
| Scaffold, PWA, SwiftUI client | `broomva/walkie` |
| Routes, ask log, conversational agent, D, dispatch+hold | `broomva/genesis` |

`queue.jsonl` holds `VoiceTicket` — caller-originated intake keyed by an explicitly
untrusted phone number. An **ask** is `pendingQuestion` in `RunState`
(`packages/projection/src/reducer.ts:210`) — projection state, persisted nowhere, cleared
on tool result. Genesis has **no ask log**; walkie builds one beside the queue. **Do not
merge them.**

The record is `docs/specs/2026-08-30-walkie-target-architecture.html` in
`broomva/workspace`.
