import type { Store } from "@genesis/core";
import { createPgliteStore, createPostgresStore } from "@genesis/db";
import { build } from "./server";

/** Pick the durable store by deployment (Phase 2 — durable by default):
 *  DATABASE_URL → Postgres (Railway in prod); else persistent pglite on disk
 *  (FS-as-truth — sessions survive restart without any external DB). */
async function selectStore(): Promise<{ store: Store; label: string }> {
  const url = process.env.DATABASE_URL;
  if (url) return { store: await createPostgresStore(url), label: "postgres" };
  const dir = process.env.GENESIS_DATA_DIR ?? `${process.env.HOME}/.genesis/data`;
  return { store: await createPgliteStore(dir), label: `pglite:${dir}` };
}

const workspaceRoot = process.env.GENESIS_WORKSPACE ?? process.cwd();
const port = Number(process.env.PORT ?? 8787);

// NOTE (Phase 2 Slice A): dispatch is serialized per-thread IN-PROCESS only.
// Run a SINGLE instance until Slice B adds Upstash slot-locks — two replicas on
// one Postgres can race the same thread and corrupt --resume continuity (P20 #3).
let store: Store;
let label: string;
try {
  ({ store, label } = await selectStore());
} catch (e) {
  console.error(
    `[genesis] failed to open the store (check DATABASE_URL): ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(1);
}
const { app, websocket } = build({
  workspaceRoot,
  extraArgs: process.env.GENESIS_AGENT_ARGS?.split(" ").filter(Boolean),
  token: process.env.GENESIS_TOKEN,
  store,
});

console.log(
  `[genesis] local channel → http://localhost:${port}  (workspace: ${workspaceRoot}, store: ${label})`,
);
export default { port, fetch: app.fetch, websocket };
