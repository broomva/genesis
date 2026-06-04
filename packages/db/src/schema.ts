// Drizzle schema — the durable shape of a Genesis "self".
// Phase 2 promotes the Phase-1 in-memory Workspace/Session/Turn to Postgres rows.
import { index, pgTable, text } from "drizzle-orm/pg-core";

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  threadId: text("thread_id").notNull().unique(),
  agentSessionId: text("agent_session_id"), // null until the first run resumes
  phase: text("phase").notNull(),
  createdAt: text("created_at").notNull(),
});

export const turns = pgTable(
  "turns",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    role: text("role").notNull(),
    text: text("text").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({ bySession: index("turns_session_idx").on(t.sessionId) }),
);

// Idempotent schema bootstrap — runs on store creation (FS-as-truth: the DB IS
// the truth, recreated on demand). Multi-statement; executed via the raw client.
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
  session_id text NOT NULL,
  role text NOT NULL,
  text text NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS turns_session_idx ON turns (session_id);
`;
