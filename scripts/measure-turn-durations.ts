#!/usr/bin/env bun
// BRO-2390 — measure D, the hold deadline, from the store rather than from recall.
//
// THE POINT OF THIS FILE. The declared architecture names D as a measurement that
// has not been taken and refuses to let step 4's hold ship without it. Two anchors
// exist in prose — "~9s trivial, 30s+ real" — and a deadline is a property of the
// DISTRIBUTION, not of two anecdotes. So: read the real turns, print the real
// distribution, and either name D with its percentile and the count of
// observations above it, or say "insufficient data" and name nothing.
//
// IT DOES NOT GO THROUGH createPgliteStore/createPostgresStore, and that is the
// whole reason this file opens its own client.
//
// The first version used the store factory and its header said "It NEVER writes.
// Point it at production if you like." That was FALSE, and false in the dangerous
// direction: both factories run MIGRATE_SQL on open
// (packages/db/src/factory.ts:13 and :24) — CREATE TABLE IF NOT EXISTS plus seven
// ALTER TABLE ... ADD COLUMN IF NOT EXISTS (packages/db/src/schema.ts:97-124).
// That is DDL. On Postgres an ALTER takes an ACCESS EXCLUSIVE lock even when the
// column already exists, so "just measuring production" would have briefly
// blocked every reader and writer of `sessions` and `turns`. The measurement in
// this change was taken against a snapshot copy, so nothing happened — but the
// header invited exactly the thing it promised was safe.
//
// So: one SELECT, no DDL, no migration, no lock. If the table is absent the query
// errors, which is the correct behaviour for a read-only tool — creating what it
// came to measure is how a reader becomes a writer.
//
// RESIDUAL, stated rather than papered over: for pglite, OPENING a data directory
// is itself a write — it is a Postgres data dir and the engine will run recovery
// and touch WAL regardless of what SQL follows. There is no read-only open. So
// for pglite, snapshot the directory and point this at the copy. For Postgres,
// a plain SELECT over the wire genuinely touches nothing.
//
// Usage:
//   bun scripts/measure-turn-durations.ts            # DATABASE_URL, else pglite
//   bun scripts/measure-turn-durations.ts --json     # machine-readable
//   GENESIS_DATA_DIR=/path/to/SNAPSHOT bun scripts/measure-turn-durations.ts

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
// The read-only opener, NOT the factory. It lives in packages/db beside the
// factory it avoids, because that is where the drivers resolve: this repo has no
// node_modules at the root, so a script here cannot import @electric-sql/pglite
// or postgres directly — discovered by running it, which failed with "Cannot find
// module". scripts/measure-readonly.test.ts asserts neither this file nor that
// one can reach MIGRATE_SQL.
import { openReadOnly } from "../packages/db/src/readonly";
import { chooseD, fractionUnder, implausiblyFast, summarize } from "./duration-stats";

/** The percentile D is taken at, stated here rather than buried in a call.
 *
 *  p90, not p95 or p50. D is a HOLD deadline: how long the voice layer waits
 *  before telling the caller it will follow up. Too short and it abandons turns
 *  that were about to answer; too long and every slow turn holds a human on a
 *  line. p50 abandons half of them. p95 makes the common case wait for the worst
 *  case. p90 keeps nine turns in ten inside the hold, and the tenth is exactly
 *  the case the follow-up path exists to serve.
 *
 *  Overridable, because the right answer is a product decision and this is a
 *  measurement tool: --percentile 0.95. */
const DEFAULT_P = 0.9;

/** One SELECT each. No factory, no MIGRATE_SQL, no DDL, no lock. */
async function readDurations(): Promise<{ label: string; sessions: number; durations: number[] }> {
  // `role <> 'user'` because a user turn carries no server-measured run time, and
  // counting its absent value as anything would be inventing data.
  const SQL =
    "SELECT duration_ms FROM turns WHERE duration_ms IS NOT NULL AND duration_ms >= 0 AND role <> 'user'";
  const COUNT = "SELECT count(*)::int AS n FROM sessions";
  const { client, label } = await openReadOnly({
    databaseUrl: process.env.DATABASE_URL,
    dataDir: process.env.GENESIS_DATA_DIR ?? join(homedir() || tmpdir(), ".genesis", "data"),
  });
  try {
    const rows = await client.query<{ duration_ms: number }>(SQL);
    const counted = await client.query<{ n: number }>(COUNT);
    return {
      label,
      sessions: Number(counted[0]?.n ?? 0),
      durations: rows.map((r) => Number(r.duration_ms)),
    };
  } finally {
    await client.close();
  }
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const pArg = args.indexOf("--percentile");
const p = pArg >= 0 ? Number(args[pArg + 1]) : DEFAULT_P;
if (!(p >= 0 && p <= 1)) {
  console.error(`--percentile must be in [0,1], got ${args[pArg + 1]}`);
  process.exit(2);
}

const { label, sessions: sessionCount, durations } = await readDurations();

const summary = summarize(durations);
const verdict = chooseD(durations, p);
// Candidate holds a caller might actually tolerate as silence, and the share of
// turns that land inside each. This is the table step 4 needs; the percentiles
// above are what makes it trustworthy.
const HOLDS_MS = [5_000, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000];
const coverage = HOLDS_MS.map((ms) => ({ holdMs: ms, fraction: fractionUnder(durations, ms) }));
const report = {
  store: label,
  sessions: sessionCount,
  ...summary,
  underOneSecond: implausiblyFast(durations),
  coverage,
  verdict,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const ms = (v?: number) => (v === undefined ? "—" : `${(v / 1000).toFixed(1)}s`);
  console.log(`store    ${label}`);
  console.log(`sessions ${sessionCount}`);
  console.log(`n        ${summary.n} agent turns carrying a durationMs`);
  console.log(`distinct ${summary.distinct}`);
  console.log(
    `min ${ms(summary.min)}  median ${ms(summary.median)}  p75 ${ms(summary.p75)}  p90 ${ms(summary.p90)}  p95 ${ms(summary.p95)}  max ${ms(summary.max)}`,
  );
  console.log(
    `under 1s ${implausiblyFast(durations)} (not plausibly real agent completions; left in, reported)`,
  );
  console.log("");
  console.log("hold     share of turns finishing inside it");
  for (const c of coverage) {
    const pct = c.fraction === undefined ? "—" : `${(c.fraction * 100).toFixed(0)}%`;
    console.log(`  ${(c.holdMs / 1000).toString().padStart(2)}s    ${pct}`);
  }
  console.log("");
  console.log(
    verdict.sufficient
      ? `p${Math.round(p * 100)} = ${ms(verdict.D)}  (${verdict.reason})`
      : `INSUFFICIENT DATA — ${verdict.reason}`,
  );
}

// Exit 1 on insufficient data so a caller cannot mistake "no number" for "a
// number". A script that exits 0 having printed nothing usable is one a later
// pipeline reads as success.
process.exit(verdict.sufficient ? 0 : 1);
