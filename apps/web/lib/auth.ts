// Better Auth — single-user passkey gate for the Genesis PWA.
//
// Storage: a pglite-backed Drizzle instance, SEPARATE from `@genesis/db` (the
// engine's store). Pure-JS (WASM) — no native deps — so it does not break the
// Next `output: "standalone"` build. The DB file lives at `AUTH_DB_PATH`
// (default `./.data/auth`). Tables are created on boot via `AUTH_MIGRATE_SQL`
// (CREATE … IF NOT EXISTS), mirroring the bootstrap pattern in `packages/db`.
//
// Closed signup: `emailAndPassword.enabled = false` — there is NO open
// registration endpoint. Passkeys are added only by an already-authenticated
// session (the @better-auth/passkey plugin's `registration.requireSession`
// defaults to true). The single owner is created once via
// `app/api/auth/bootstrap/route.ts`, gated by `AUTH_BOOTSTRAP_TOKEN` AND a
// zero-users precondition. See README for the full flow.
//
// API surface used (verified against better-auth@1.6.22 + @better-auth/passkey@1.6.22):
//   betterAuth({ database, plugins, emailAndPassword, baseURL, secret })
//   drizzleAdapter(db, { provider: "pg", schema })   — from "better-auth/adapters/drizzle"
//   passkey({ rpID, rpName, origin })                — from "@better-auth/passkey"
//   nextCookies()                                    — from "better-auth/next-js"
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { passkey } from "@better-auth/passkey";
import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { drizzle } from "drizzle-orm/pglite";
import { AUTH_MIGRATE_SQL, authSchema } from "./auth-schema";

// `BETTER_AUTH_URL` is the canonical base URL (e.g.
// https://srv1692698-agent.tailf3e897.ts.net or http://localhost:3000). Both
// the passkey relying-party config and Better Auth's own baseURL derive from it.
const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

// rpID is the registrable domain (host without scheme/port). WebAuthn binds a
// credential to this exact value — a passkey enrolled under one rpID will not
// authenticate under another. Derived from BETTER_AUTH_URL so dev (localhost)
// and the tailnet host each get the right rpID with no separate env var.
const rpID = (() => {
  try {
    return new URL(baseURL).hostname;
  } catch {
    return "localhost";
  }
})();

// pglite-backed Drizzle store — LAZILY constructed on first real DB access, not
// at module load. This matters because route modules are evaluated during
// `next build` static generation (in a worker where the PGlite WASM cannot
// init); a top-level `new PGlite()` would throw there. The drizzle adapter only
// touches the db per-operation (db.select/insert/…), so a lazy proxy defers all
// WASM work to the first actual request. PGlite serializes operations FIFO, so
// issuing the migration as the first queued op guarantees the tables exist
// before the adapter's first query (verified: later queries enqueue after exec).
const dataDir = process.env.AUTH_DB_PATH ?? "./.data/auth";

let realDb: ReturnType<typeof drizzle> | undefined;
// Resolves once the CREATE TABLE batch has run. `authDbReady` lets the bootstrap
// route await schema creation before counting users; it triggers lazy init.
let readyResolve!: () => void;
let readyReject!: (err: unknown) => void;
export const authDbReady: Promise<void> = new Promise((res, rej) => {
  readyResolve = res;
  readyReject = rej;
});

function getDb(): ReturnType<typeof drizzle> {
  if (realDb) return realDb;
  // PGlite's NodeFS only mkdir's the immediate dir, not nested parents, so
  // ensure the parent exists (e.g. `./.data` for the default `./.data/auth`).
  mkdirSync(dirname(dataDir), { recursive: true });
  const client = new PGlite(dataDir);
  // The CREATE TABLE batch is the first queued op on the FIFO client.
  client
    .exec(AUTH_MIGRATE_SQL)
    .then(() => readyResolve())
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[auth] failed to create auth tables in ${dataDir}: ${detail}`);
      readyReject(err);
    });
  realDb = drizzle(client);
  return realDb;
}

// Lazy proxy passed to the drizzle adapter: any property access (db.select, …)
// forces construction + migration, but nothing happens until the first request.
// Exported as `authDb` (BRO-1618) so preferences-store.ts can query the user's
// `settings` column directly via Drizzle — call ensureAuthDb() first to guarantee
// the migration (incl. the settings ALTER) has run.
const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});

export { db as authDb };

// Trigger lazy DB construction + migration and resolve once the tables exist.
// Call this at the top of any route that queries the auth store directly
// (e.g. the bootstrap route) so the schema is guaranteed present. Awaiting
// `authDbReady` alone would deadlock — it only resolves after `getDb()` runs.
export async function ensureAuthDb(): Promise<void> {
  getDb();
  await authDbReady;
}

export const auth = betterAuth({
  // Base URL + secret. BETTER_AUTH_SECRET is required in prod (32+ random
  // chars); Better Auth reads it from env automatically, but we pass it
  // explicitly so a missing secret is obvious at the call site.
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    // Pass the explicit schema so the adapter maps to our exact (quoted,
    // camelCase) column names rather than inferring snake_case.
    schema: authSchema,
  }),
  // Closed signup: no open email/password registration. The owner is created
  // once via the bootstrap route; thereafter sign-in is passkey-only.
  emailAndPassword: {
    enabled: false,
  },
  plugins: [
    passkey({
      rpID,
      rpName: "Genesis",
      // origin defaults to the request origin; pinning it to baseURL hardens
      // the relying-party check to exactly this deployment.
      origin: baseURL,
      // registration.requireSession defaults to true — passkeys can only be
      // added by an authenticated session. Left at the default deliberately:
      // it is the second half of the closed-signup guarantee (the first being
      // emailAndPassword.enabled = false).
    }),
    // nextCookies() MUST be last — it forwards Set-Cookie from server actions /
    // route handlers so the session cookie is actually written.
    nextCookies(),
  ],
});
