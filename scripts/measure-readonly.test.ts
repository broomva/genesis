// The read-only claim, made enforceable.
//
// The first version of measure-turn-durations.ts said "It NEVER writes. Point it
// at production if you like." and imported createPgliteStore — which runs
// MIGRATE_SQL on open: CREATE TABLE IF NOT EXISTS plus seven ALTER TABLE ... ADD
// COLUMN. On Postgres an ALTER takes an ACCESS EXCLUSIVE lock even when the
// column already exists. The claim was false, in the direction that would have
// blocked every reader and writer of `sessions` and `turns` on a live database.
//
// A prose claim nothing enforces is the defect class this arc keeps producing, so
// the claim is now a test. These are source assertions rather than behavioural
// ones deliberately: the property is "this file does not reach the code that
// migrates", and that is a fact about imports, not about a run.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReadOnly } from "../packages/db/src/readonly";

const SRC = readFileSync(join(import.meta.dir, "measure-turn-durations.ts"), "utf8");
const READONLY_SRC = readFileSync(
  join(import.meta.dir, "..", "packages", "db", "src", "readonly.ts"),
  "utf8",
);

/** Source with // and /* *\/ comments removed.
 *
 *  Necessary, and learned the hard way in the sibling ticket: the file's header
 *  NAMES createPgliteStore in prose explaining why it is not used, so a bare
 *  substring search matches the explanation and the test passes for the wrong
 *  reason — or fails for one. */
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = strip(SRC);
const readonlyCode = strip(READONLY_SRC);

describe("the measurement script cannot migrate the database it measures", () => {
  test("it does not import the store factories", () => {
    expect(code).not.toContain("createPgliteStore");
    expect(code).not.toContain("createPostgresStore");
  });

  test("the only packages/db module it imports is the read-only opener", () => {
    // It DOES import from packages/db — it has to, because the drivers resolve
    // there and not at the repo root. So the assertion is not "no packages/db"
    // but "nothing from packages/db that can migrate": not ./index (which
    // re-exports the factory and the schema), not ./factory, not ./schema.
    const imports = [...code.matchAll(/from\s+["']([^"']*packages\/db[^"']*)["']/g)].map(
      (m) => m[1],
    );
    expect(imports).toEqual(["../packages/db/src/readonly"]);
    expect(code).not.toMatch(/from\s+["']@genesis\/db["']/);
  });

  test("the read-only opener cannot reach MIGRATE_SQL either", () => {
    // The claim has to hold one level down, or it is only true of this file.
    expect(readonlyCode).not.toContain("MIGRATE_SQL");
    expect(readonlyCode).not.toMatch(/from\s+["']\.\/schema["']/);
    expect(readonlyCode).not.toMatch(/from\s+["']\.\/factory["']/);
    for (const ddl of ["CREATE TABLE", "ALTER TABLE", "DROP TABLE", "INSERT INTO", "DELETE FROM"]) {
      expect(readonlyCode).not.toContain(ddl);
    }
  });

  test("it never executes MIGRATE_SQL or any DDL", () => {
    expect(code).not.toContain("MIGRATE_SQL");
    for (const ddl of [
      "CREATE TABLE",
      "ALTER TABLE",
      "DROP TABLE",
      "INSERT INTO",
      "UPDATE ",
      "DELETE FROM",
    ]) {
      expect(code).not.toContain(ddl);
    }
  });

  test("every SQL string it does contain is a SELECT", () => {
    // The positive control for the checks above: they are all negative, and a
    // file with no SQL at all would satisfy every one of them. This asserts the
    // queries exist AND are reads.
    const statements = code.match(/"(SELECT[^"]*)"/g) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) expect(s).toMatch(/^"SELECT /);
  });

  test("the comment-stripper actually strips — the check is not vacuous", () => {
    // If the regex failed to strip anything, `code` would still contain the
    // header prose naming createPgliteStore and the first test would fail. If it
    // stripped EVERYTHING, every test above would pass over an empty string. Pin
    // both ends.
    expect(code.length).toBeGreaterThan(200);
    expect(code.length).toBeLessThan(SRC.length);
    expect(SRC).toContain("createPgliteStore"); // present in prose...
    expect(code).not.toContain("createPgliteStore"); // ...and only in prose
  });

  test("BEHAVIOURAL: a store without the schema ERRORS rather than being migrated", async () => {
    // The source assertions above are all about imports. This one runs the thing.
    // The factory-based version of this script would open a fresh directory,
    // silently CREATE TABLE turns, and report a cheerful n=0 — a reader that
    // creates what it came to measure. This must fail instead.
    //
    // The pglite CLUSTER directory is still created; opening a Postgres data dir
    // runs initdb and there is no read-only open. That residual is documented in
    // readonly.ts. What must not happen is OUR schema appearing.
    const dir = mkdtempSync(join(tmpdir(), "readonly-"));
    try {
      const { client } = await openReadOnly({ dataDir: join(dir, "fresh") });
      let message = "";
      try {
        await client.query("SELECT duration_ms FROM turns");
      } catch (e) {
        message = String((e as Error)?.message ?? e);
      } finally {
        await client.close();
      }
      expect(message).toContain('relation "turns" does not exist');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
