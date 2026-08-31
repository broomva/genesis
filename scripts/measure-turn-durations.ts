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
// IT READS THROUGH THE STORE'S PUBLIC API, not raw SQL. listSessions() +
// turnsForSession() work identically against pglite and Postgres, so the same
// script measures a laptop and production without a second code path — and
// without this script needing to know the schema, which is the thing most likely
// to drift under it.
//
// Usage:
//   bun scripts/measure-turn-durations.ts            # DATABASE_URL, else pglite
//   bun scripts/measure-turn-durations.ts --json     # machine-readable
//   GENESIS_DATA_DIR=/path bun scripts/measure-turn-durations.ts
//
// It NEVER writes. Point it at production if you like.

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
// RELATIVE, not "@genesis/db", and that is forced rather than chosen. The
// workspace links live under apps/api/node_modules — the repo root has no
// @genesis/* — so a script here cannot resolve the package specifier. Every other
// file in scripts/ imports only node builtins and its own siblings, so there is
// no precedent to copy either. Reaching into the package source keeps the
// dependency visible in the import path instead of hiding it behind a manifest
// change to the root, which would touch bun.lock for one script.
import { createPgliteStore, createPostgresStore } from "../packages/db/src/index";
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

async function selectStore(): Promise<{
  store: {
    listSessions: () => Promise<{ id: string }[]>;
    turnsForSession: (id: string) => Promise<{ role: string; durationMs?: number }[]>;
    close: () => Promise<void>;
  };
  label: string;
}> {
  const url = process.env.DATABASE_URL;
  if (url) {
    // Host only — a connection string carries credentials and this prints.
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return "(unparseable)";
      }
    })();
    return { store: (await createPostgresStore(url)) as never, label: `postgres:${host}` };
  }
  const dir = process.env.GENESIS_DATA_DIR ?? join(homedir() || tmpdir(), ".genesis", "data");
  return { store: (await createPgliteStore(dir)) as never, label: `pglite:${dir}` };
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const pArg = args.indexOf("--percentile");
const p = pArg >= 0 ? Number(args[pArg + 1]) : DEFAULT_P;
if (!(p >= 0 && p <= 1)) {
  console.error(`--percentile must be in [0,1], got ${args[pArg + 1]}`);
  process.exit(2);
}

const { store, label } = await selectStore();
const sessions = await store.listSessions();
const durations: number[] = [];
for (const s of sessions) {
  for (const t of await store.turnsForSession(s.id)) {
    // Agent turns only. A user turn has no server-measured run time, and
    // counting its absent duration as anything would be inventing data.
    if (t.role !== "user" && typeof t.durationMs === "number" && t.durationMs >= 0) {
      durations.push(t.durationMs);
    }
  }
}
await store.close();

const summary = summarize(durations);
const verdict = chooseD(durations, p);
// Candidate holds a caller might actually tolerate as silence, and the share of
// turns that land inside each. This is the table step 4 needs; the percentiles
// above are what makes it trustworthy.
const HOLDS_MS = [5_000, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000];
const coverage = HOLDS_MS.map((ms) => ({ holdMs: ms, fraction: fractionUnder(durations, ms) }));
const report = {
  store: label,
  sessions: sessions.length,
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
  console.log(`sessions ${sessions.length}`);
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
