# D, the hold deadline — measured (BRO-2390)

**Regenerate every number on this page:**

```bash
bun scripts/measure-turn-durations.ts            # human-readable
bun scripts/measure-turn-durations.ts --json     # machine-readable
```

Nothing here is transcribed from recall. If the script and this page disagree,
the script is right and this page is stale.

## What was measured

Server-measured agent run time per turn — `turns.duration_ms`, written at
`packages/core/src/supervisor.ts:938` (`Date.now() - startedAt`) and persisted at
`packages/db/src/store.ts:216`. **No new column was needed**; the ticket asked
that this be checked before adding one, and it already covers the quantity.

Read through the store's public API (`listSessions` + `turnsForSession`), so the
same script measures pglite and Postgres without a second code path.

Source: the production store, `pglite:/home/agent/.config/genesis-bot/data`, read
from a **snapshot copy** so the live process was never touched.

**On "read-only", precisely.** The first version of this script used
`createPgliteStore` and claimed it never wrote. That was false: both factories run
`MIGRATE_SQL` on open (`packages/db/src/factory.ts:13`, `:24`) — `CREATE TABLE IF
NOT EXISTS` plus seven `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
(`packages/db/src/schema.ts:97-124`). On Postgres an `ALTER` takes an
`ACCESS EXCLUSIVE` lock even when the column already exists, so pointing it at a
live database would have briefly blocked every reader and writer of `sessions` and
`turns`. Caught in review before it was ever aimed at production.

It now opens through `packages/db/src/readonly.ts`, which cannot reach
`MIGRATE_SQL` — asserted by `scripts/measure-readonly.test.ts`, including
behaviourally: pointed at a store without the schema it reports
`relation "turns" does not exist` rather than creating it.

**Residual, stated rather than papered over:** for pglite, *opening* a data
directory is itself a write — it is a Postgres data dir and the engine runs initdb
and recovery regardless of what SQL follows. There is no read-only open. So for
pglite: snapshot the directory and point this at the copy, which is what was done
here. For Postgres, a `SELECT` over the wire genuinely touches nothing.

## The distribution

```
sessions 226
n        317 agent turns carrying a durationMs
distinct 315
min 0.0s  median 20.0s  p75 40.9s  p90 87.5s  p95 144.2s  max 937.9s
under 1s 1   (not plausibly a real completion; left in the sample, reported)
```

`distinct` is 315 of 317 — the field genuinely varies, so it is a measurement and
not a stuck instrument. Exactly one observation is under a second, so the fast
tail is not error paths in disguise.

## This refutes the anchors the design was carrying

The declared architecture names two anchors, "~9s trivial, 30s+ real". Measured:

| anchor | prose | actual |
|---|---|---|
| trivial | ~9s | **median 20.0s** |
| real | 30s+ | **p90 87.5s**, p95 144.2s |

A deadline guessed from those anchors would have been low by roughly 3×. This is
what the ticket meant by *a guessed deadline is a fabricated quantity* — the
anchors were not wrong about the shape, they were wrong about the scale, and two
anecdotes cannot tell you which.

## Choosing D — the question inverted

"What is p90" is the wrong first question. D is not free to be whatever the
distribution says: it is bounded above by what a person tolerates as silence on a
call, and p90 is **87.5 seconds**. Nobody holds a line that long.

So the decision-relevant direction is the other one — at a hold a caller will
actually tolerate, what share of turns land inside it:

| hold | turns finishing inside |
|---|---|
| 5s | 14% |
| 10s | 29% |
| 15s | 38% |
| 20s | 51% |
| **30s** | **67%** |
| 45s | 77% |
| 60s | 84% |

Marginal coverage per second of hold:

| step | points gained | per second |
|---|---|---|
| 5→10s | +15 | 3.00 |
| 15→20s | +13 | 2.60 |
| 20→30s | +16 | 1.60 |
| 30→45s | +10 | **0.67** |
| 45→60s | +7 | **0.47** |

The return collapses after 30s.

## Decision

**D = 30s, which is the 67th percentile of n=317.**

Chosen at the knee of the coverage curve: every second up to 30 buys at least 1.6
points of coverage, and every second after buys less than 0.7. It is also inside
what a voice agent can fill with speech rather than silence.

## The finding that matters more than D

**At D = 30s, a third of turns do not finish inside the hold.** The follow-up path
is not an exception handler — it runs for roughly **1 turn in 3**, and at any
tolerable hold it runs for at least 1 in 6. Step 4 (BRO-2391) must treat it as a
primary path with its own design and its own tests, not as a timeout branch.

No hold under a minute makes this rare. That is a property of the workload, and it
is not fixable by choosing a different D.

## Caveats, stated rather than buried

- **n=317 from one deployment.** Representative of this operator's workload, not
  of voice traffic in general. The distribution should be re-measured once voice
  turns exist, because a caller-driven turn may be shorter than a chat-driven one.
- **Agent turns only.** User turns carry no server-measured duration; counting
  their absent value as anything would be inventing data.
- **`durationMs` is agent run time**, not end-to-end request latency. It excludes
  dispatch queueing and transport. For a hold deadline that is the conservative
  direction — real end-to-end is longer, so a D chosen from this is if anything
  slightly optimistic.

## DoD

| item | state |
|---|---|
| 1 · a committed script regenerates the numbers | `scripts/measure-turn-durations.ts` + `scripts/duration-stats.ts` |
| 2 · the report states n, and refuses a number when n is too small | n=317. `chooseD` refuses on an empty sample, on a constant sample, and when fewer than 2 observations sit above the percentile — each pinned by a test and a mutant |
| 3 · D recorded with percentile and rationale | above |
| 4 · read from the store or configured, never hard-coded | this document names 30s; step 4 must take it from config. No source file in this change contains a hold constant |
