// Read-only access to the store, for tools that must not migrate what they measure.
//
// WHY THIS EXISTS BESIDE factory.ts RATHER THAN INSIDE IT. Both factories run
// MIGRATE_SQL on open — factory.ts:13 and factory.ts:24 — which is CREATE TABLE
// IF NOT EXISTS plus seven ALTER TABLE ... ADD COLUMN IF NOT EXISTS
// (schema.ts:97-124). That is correct for a server: it is how an additive
// migration reaches a running deployment. It is wrong for a measurement tool,
// and wrong in the dangerous direction — on Postgres an ALTER takes an ACCESS
// EXCLUSIVE lock even when the column already exists, so a script that only
// wanted to read would briefly block every reader and writer of `sessions` and
// `turns`.
//
// A tool that opens the store to look at it must not be able to change it. This
// module deliberately imports NOTHING from ./schema, so MIGRATE_SQL is not
// reachable from here even by accident, and scripts/measure-readonly.test.ts
// asserts that.
//
// RESIDUAL, stated rather than papered over: for pglite, OPENING a data directory
// is itself a write. It is a Postgres data dir; the engine runs recovery and
// touches WAL regardless of what SQL follows. There is no read-only open. So for
// pglite, snapshot the directory and point this at the copy. For Postgres, a
// SELECT over the wire genuinely touches nothing.

/** The narrow surface a read-only consumer needs. Deliberately not `Store`:
 *  that interface has upsert/add/delete on it, and a type that can express a
 *  write is one a later edit can perform. */
export interface ReadOnlyClient {
  /** Run a SELECT. The caller owns the SQL; this module refuses to build it,
   *  because a query builder here would be the seam through which a write
   *  eventually arrives. */
  query<T>(sql: string): Promise<T[]>;
  close(): Promise<void>;
}

/** Open the store read-only. DATABASE_URL wins, exactly as the server chooses.
 *
 *  Returns a `label` naming what was opened, so a report can state its source.
 *  For Postgres the label carries the HOST ONLY — a connection string carries
 *  credentials and these labels get printed. */
export async function openReadOnly(opts: {
  databaseUrl?: string | undefined;
  dataDir?: string | undefined;
}): Promise<{ client: ReadOnlyClient; label: string }> {
  if (opts.databaseUrl) {
    const url = opts.databaseUrl;
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return "(unparseable)";
      }
    })();
    const postgres = (await import("postgres")).default;
    // max: 1 — a measurement should occupy one connection, not five.
    const sql = postgres(url, { max: 1 });
    return {
      label: `postgres:${host}`,
      client: {
        query: async <T>(q: string) => (await sql.unsafe(q)) as unknown as T[],
        close: async () => {
          await sql.end();
        },
      },
    };
  }
  if (!opts.dataDir) throw new Error("openReadOnly needs a databaseUrl or a dataDir");
  const dir = opts.dataDir;
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(dir);
  return {
    label: `pglite:${dir}`,
    client: {
      query: async <T>(q: string) => (await pg.query<T>(q)).rows,
      close: () => pg.close(),
    },
  };
}
