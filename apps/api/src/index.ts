import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "@genesis/core";
import { createPgliteStore, createPostgresStore } from "@genesis/db";
import { type ExecutionHost, createVercelSandboxHost } from "@genesis/host";
import { build } from "./server";

const defaultDataDir = () =>
  process.env.GENESIS_DATA_DIR ?? join(homedir() || tmpdir(), ".genesis", "data");

/** Pick the execution host. GENESIS_HOST=vercel → microVM tier (Vercel Sandbox,
 *  Phase 4): Firecracker VM, deny-all egress, keyed creds (ANTHROPIC_API_KEY).
 *  Requires Vercel auth in env (VERCEL_OIDC_TOKEN, or VERCEL_TOKEN + team/project).
 *  Default → LocalHost. NOTE: this is one shared sandbox; per-session sandboxes
 *  (name = sessionId) land with the HostProvider seam in the Chat SDK channel. */
async function selectHost(): Promise<{ host?: ExecutionHost; label: string }> {
  if (process.env.GENESIS_HOST !== "vercel") return { host: undefined, label: "local" };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const { host } = await createVercelSandboxHost({
    sessionName: process.env.GENESIS_SANDBOX_NAME ?? "genesis-default",
    reuse: true,
    gitUrl: process.env.GENESIS_GIT_URL,
    runtime: "node24",
    networkPolicy: (process.env.GENESIS_NETWORK_POLICY as "deny-all" | "allow-all") ?? "deny-all",
    timeoutMs: Number(process.env.GENESIS_SANDBOX_TIMEOUT_MS ?? 45 * 60 * 1000),
    env: apiKey ? { ANTHROPIC_API_KEY: apiKey } : undefined,
    bootstrap: process.env.GENESIS_SANDBOX_BOOTSTRAP
      ? [process.env.GENESIS_SANDBOX_BOOTSTRAP.split(" ")]
      : undefined,
  });
  return { host, label: "vercel-sandbox(microvm)" };
}

/** Pick the durable store by deployment (Phase 2 — durable by default):
 *  DATABASE_URL → Postgres (Railway in prod); else persistent pglite on disk
 *  (FS-as-truth — sessions survive restart without any external DB). */
async function selectStore(): Promise<{ store: Store; label: string }> {
  const url = process.env.DATABASE_URL;
  if (url) return { store: await createPostgresStore(url), label: "postgres" };
  const dir = defaultDataDir();
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

let host: ExecutionHost | undefined;
let hostLabel: string;
try {
  ({ host, label: hostLabel } = await selectHost());
} catch (e) {
  console.error(
    `[genesis] failed to start the execution host (check Vercel auth): ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(1);
}

const { app, websocket } = build({
  workspaceRoot,
  extraArgs: process.env.GENESIS_AGENT_ARGS?.split(" ").filter(Boolean),
  token: process.env.GENESIS_TOKEN,
  store,
  host,
});

console.log(
  `[genesis] local channel → http://localhost:${port}  (workspace: ${workspaceRoot}, store: ${label}, host: ${hostLabel})`,
);
export default { port, fetch: app.fetch, websocket };
