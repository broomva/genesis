// Store factories — pick a driver by deployment. pglite for tests + local
// FS-as-truth (persistent dir = sessions survive restart); postgres-js for prod.

import { MIGRATE_SQL } from "./schema";
import { DrizzleStore } from "./store";

/** pglite-backed store. `dataDir` undefined → ephemeral in-memory (tests);
 *  a path → persistent on disk (the FS-as-truth continuity default). */
export async function createPgliteStore(dataDir?: string): Promise<DrizzleStore> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite(dataDir);
  await client.exec(MIGRATE_SQL);
  const db = drizzle(client);
  return new DrizzleStore(db, () => client.close());
}

/** postgres-js store for a DATABASE_URL (Railway Postgres in prod). */
export async function createPostgresStore(url: string): Promise<DrizzleStore> {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  const client = postgres(url, { max: 5 });
  await client.unsafe(MIGRATE_SQL);
  const db = drizzle(client);
  return new DrizzleStore(db, async () => {
    await client.end();
  });
}
