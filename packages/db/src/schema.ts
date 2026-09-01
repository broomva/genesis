// Drizzle schema — the durable shape of a Genesis "self".
// Phase 2 promotes the Phase-1 in-memory Workspace/Session/Turn to Postgres rows.
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
} from "drizzle-orm/pg-core";

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull(),
  // BRO-2236. `confined` decides whether a turn gets --strict-mcp-config. Before
  // this column it lived only on the in-memory registry, so a workspace resolved
  // from the DB arrived with confined: undefined and hardenedExtraArgs
  // short-circuited -- the tenant ran with the operator's MCP servers attached.
  // Nullable on purpose: null means "never stated", which the read path treats as
  // NOT confined and refuses to serve on a channel, rather than guessing.
  confined: boolean("confined"),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  threadId: text("thread_id").notNull().unique(),
  agentSessionId: text("agent_session_id"), // null until the first run resumes
  phase: text("phase").notNull(),
  createdAt: text("created_at").notNull(),
  // Session management (BRO-1592): soft-archive (hide from the default drawer
  // list, reversible) + a human-readable title (auto-derived from the first
  // user turn, or renamed). Both additive — see the ALTER block in MIGRATE_SQL.
  archived: boolean("archived").notNull().default(false),
  title: text("title"),
  // Per-thread sticky engine binding (BRO-1620): "print" | "interactive", set on
  // the first turn, reused after. Additive — see the ALTER block. NULL → the
  // supervisor's defaultEngine at read time.
  engine: text("engine"),
  // Per-thread sticky worktree posture (BRO-1656): true = run at the workspace root,
  // false = cut a per-session worktree. Set on the first turn, reused after — so a
  // resumed thread keeps its cwd posture instead of re-deriving it from the (mutable)
  // workspace registry. NULL → inherit the workspace/global default at read time.
  noWorktree: boolean("no_worktree"),
  // The git branch the session's cwd is on (BRO-1664) — captured from each run so a
  // reloaded thread's header shows `<workspace> · <branch>`. Additive — see the ALTER
  // block. NULL → non-git cwd / never-run (header falls back to the run posture).
  branch: text("branch"),
});

export const turns = pgTable(
  "turns",
  {
    id: text("id").primaryKey(),
    // DB-assigned monotonic order — the authoritative transcript ordering, so
    // turns stamped in the same millisecond still order deterministically and
    // correctly across restarts (P20 #4). `createdAt` alone is not enough.
    seq: bigserial("seq", { mode: "number" }),
    sessionId: text("session_id").notNull(),
    role: text("role").notNull(),
    text: text("text").notNull(),
    createdAt: text("created_at").notNull(),
    // Per-turn token usage + exact cost (BRO-1597) — set on agent turns from the
    // CLI's terminal result, so a reloaded thread keeps its running cost + the
    // latest context-window fill. Nullable (user turns + pre-usage history).
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheCreationTokens: integer("cache_creation_tokens"),
    costUsd: doublePrecision("cost_usd"),
    // Ordered text+tool timeline (BRO-1607), JSON-encoded so a reloaded thread
    // rebuilds tool blocks + interleaving. `thinkingTokens` reloads the reasoning
    // indicator's `~N tokens`; `reasoned` (BRO-1608) decides whether it shows at
    // all (token-less at effort high). All additive + nullable — see MIGRATE_SQL.
    parts: text("parts"),
    thinkingTokens: integer("thinking_tokens"),
    reasoned: boolean("reasoned"),
    // Verbatim reasoning prose (BRO-1608) — persisted so a reload matches the live
    // turn whenever a deployment provides it; redacted to "" (→ null) on subscription.
    reasoning: text("reasoning"),
    // Server-measured agent run time in ms (BRO-1610) — "5m 24s" on a reloaded turn.
    durationMs: integer("duration_ms"),
  },
  (t) => ({ bySession: index("turns_session_idx").on(t.sessionId) }),
);

// Fresh-schema bootstrap — runs on store creation. CREATE … IF NOT EXISTS makes
// missing tables; the ADD COLUMN … IF NOT EXISTS block below carries *additive*
// migrations forward onto an existing DB (BRO-1592). Both Postgres and pglite
// support ADD COLUMN IF NOT EXISTS, so this stays a single idempotent script —
// safe to re-run on a fresh OR an up-to-date DB. Non-additive changes (drop /
// rename / type change) still need a real migration tool (drizzle-kit).
// Multi-statement; executed via the raw client.
export const MIGRATE_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  root_path text NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  thread_id text NOT NULL UNIQUE,
  agent_session_id text,
  phase text NOT NULL,
  created_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  id text PRIMARY KEY,
  seq bigserial,
  session_id text NOT NULL,
  role text NOT NULL,
  text text NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS turns_session_idx ON turns (session_id);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS confined boolean;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS engine text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS no_worktree boolean;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS branch text;
-- The thread-list page reads newest-first with an id tiebreaker, both pinned to
-- COLLATE "C". An index only serves an ORDER BY when its collation MATCHES, so the
-- pin must be repeated here; without it the planner falls back to a full scan plus
-- sort and the page is not bounded at all. Measured on PGlite, 20k sessions, one
-- page of 10:
--   no index      Seq Scan rows=20000, 217 buffers, 12.7 ms
--   this index    Index Scan rows=10,   13 buffers,  0.17 ms
-- Raw SQL rather than drizzle index(), which cannot express a per-column COLLATE.
-- NOTE: no backticks in this block. MIGRATE_SQL is a template literal and a
-- backtick here terminates it -- which is exactly how this comment first broke
-- the build.
CREATE INDEX IF NOT EXISTS sessions_page_idx ON sessions (created_at COLLATE "C" DESC, id COLLATE "C" ASC);
ALTER TABLE turns ADD COLUMN IF NOT EXISTS input_tokens integer;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS output_tokens integer;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS cache_read_tokens integer;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS cache_creation_tokens integer;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS cost_usd double precision;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS parts text;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS thinking_tokens integer;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS reasoned boolean;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS reasoning text;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS duration_ms integer;
`;
