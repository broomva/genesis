// Better Auth tables, as a Drizzle (pg) schema.
//
// These mirror Better Auth 1.6's core schema (user / session / account /
// verification) plus the @better-auth/passkey plugin's `passkey` table. The
// schema is passed to `drizzleAdapter(db, { provider: "pg", schema })` in
// `lib/auth.ts` so Better Auth reads/writes through Drizzle, and the matching
// `CREATE TABLE IF NOT EXISTS` SQL in `AUTH_MIGRATE_SQL` is run once on boot
// (mirrors the bootstrap pattern in `packages/db/src/schema.ts`).
//
// Column names are the Better Auth defaults (camelCase in app code → snake_case
// in SQL is NOT used here: Better Auth's default Drizzle mapping keeps the JS
// field name as the column name, so we declare the columns with their exact
// camelCase identifiers, e.g. `emailVerified`). Keep this file and
// `AUTH_MIGRATE_SQL` in lockstep — they describe the same tables twice (typed
// for the adapter, raw DDL for boot creation).
import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  // Per-user app preferences (BRO-1618) — a JSON blob {model,effort,theme,
  // showReasoning,…}. Queried directly via Drizzle (preferences-store.ts), NOT
  // declared to Better Auth as a managed field — the adapter ignores columns it
  // doesn't know, so this stays out of the auth surface.
  settings: text("settings"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expiresAt").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: timestamp("accessTokenExpiresAt"),
  refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

// @better-auth/passkey plugin table.
export const passkey = pgTable("passkey", {
  id: text("id").primaryKey(),
  name: text("name"),
  publicKey: text("publicKey").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  credentialID: text("credentialID").notNull(),
  counter: integer("counter").notNull(),
  deviceType: text("deviceType").notNull(),
  backedUp: boolean("backedUp").notNull(),
  transports: text("transports"),
  createdAt: timestamp("createdAt").defaultNow(),
  aaguid: text("aaguid"),
});

export const authSchema = { user, session, account, verification, passkey };

// Raw DDL run once on store creation (CREATE … IF NOT EXISTS — additive, never
// ALTERs an existing table). Safe to re-run on an up-to-date DB. Column names
// are quoted to preserve their camelCase identity in Postgres/pglite (an
// unquoted `emailVerified` would fold to lowercase, breaking the adapter's
// field→column mapping). Mirrors `packages/db/src/schema.ts` MIGRATE_SQL.
export const AUTH_MIGRATE_SQL = `
CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  "image" text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);

-- Additive: per-user preferences blob (BRO-1618). IF NOT EXISTS so re-running on
-- an existing DB is a no-op (CREATE TABLE above is a no-op once the table exists,
-- so a new column must come via ALTER — mirrors packages/db MIGRATE_SQL).
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "settings" text;

CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY,
  "expiresAt" timestamp NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "account" (
  "id" text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamp,
  "refreshTokenExpiresAt" timestamp,
  "scope" text,
  "password" text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "passkey" (
  "id" text PRIMARY KEY,
  "name" text,
  "publicKey" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "credentialID" text NOT NULL,
  "counter" integer NOT NULL,
  "deviceType" text NOT NULL,
  "backedUp" boolean NOT NULL,
  "transports" text,
  "createdAt" timestamp DEFAULT now(),
  "aaguid" text
);
`;
