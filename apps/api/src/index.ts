import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "@genesis/core";
import { createPgliteStore, createPostgresStore } from "@genesis/db";
import {
  type ExecutionHost,
  type SandboxNetworkPolicy,
  createVercelSandboxHost,
} from "@genesis/host";
import { build } from "./server";

const defaultDataDir = () =>
  process.env.GENESIS_DATA_DIR ?? join(homedir() || tmpdir(), ".genesis", "data");

/** Parse GENESIS_NETWORK_POLICY: "deny-all" | "allow-all" | a JSON allow-list
 *  object. Default (undefined) → the factory's deny-by-default agent allow-list
 *  (api.anthropic.com + npm). A blanket "deny-all" would block the keyed agent
 *  from the LLM API, so we warn loudly when it is set explicitly (P20 HIGH-3). */
function parseNetworkPolicy(): SandboxNetworkPolicy | undefined {
  const raw = process.env.GENESIS_NETWORK_POLICY;
  if (!raw) return undefined;
  if (raw === "deny-all") {
    console.warn(
      "[genesis] WARNING: networkPolicy=deny-all blocks egress to api.anthropic.com — " +
        "the agent cannot reach the LLM. Use an allow-list (default) for working runs.",
    );
    return "deny-all";
  }
  if (raw === "allow-all") return "allow-all";
  try {
    return JSON.parse(raw) as SandboxNetworkPolicy;
  } catch {
    console.warn(`[genesis] WARNING: invalid GENESIS_NETWORK_POLICY (${raw}); using default`);
    return undefined;
  }
}

/** Parse GENESIS_SANDBOX_BOOTSTRAP: a JSON array of argv arrays
 *  (e.g. [["npm","i","-g","@anthropic-ai/claude-code"]]) — handles multi-word
 *  args and multiple commands. Falls back to whitespace-split for a single
 *  simple command (P20 LOW-1). */
function parseBootstrap(): string[][] | undefined {
  const raw = process.env.GENESIS_SANDBOX_BOOTSTRAP;
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v) && v.every((c) => Array.isArray(c))) return v as string[][];
  } catch {
    // not JSON — treat as one simple, space-delimited command
  }
  return [raw.split(" ").filter(Boolean)];
}

/** Pick the execution host. GENESIS_HOST=vercel → microVM tier (Vercel Sandbox,
 *  Phase 4): Firecracker VM, deny-by-default allow-list egress, keyed creds
 *  (ANTHROPIC_API_KEY). Requires Vercel auth (VERCEL_OIDC_TOKEN, or VERCEL_TOKEN
 *  + team/project). Default → LocalHost. NOTE: this is ONE shared sandbox;
 *  per-session sandboxes (name = sessionId) land with the HostProvider seam in
 *  the Chat SDK channel (BRO-1445). The handle's stop() is registered for
 *  graceful shutdown so the persistent-by-default VM snapshots on exit (HIGH-2). */
async function selectHost(): Promise<{ host?: ExecutionHost; label: string }> {
  if (process.env.GENESIS_HOST !== "vercel") return { host: undefined, label: "local" };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // credentialTier "keyed" REQUIRES a key — fail fast, not mid-run (HIGH/MED-2).
    throw new Error(
      "GENESIS_HOST=vercel requires ANTHROPIC_API_KEY (keyed credential injected into the sandbox).",
    );
  }
  const handle = await createVercelSandboxHost({
    sessionName: process.env.GENESIS_SANDBOX_NAME ?? "genesis-default",
    reuse: true,
    gitUrl: process.env.GENESIS_GIT_URL,
    runtime: "node24",
    networkPolicy: parseNetworkPolicy(),
    timeoutMs: Number(process.env.GENESIS_SANDBOX_TIMEOUT_MS ?? 45 * 60 * 1000),
    env: { ANTHROPIC_API_KEY: apiKey },
    bootstrap: parseBootstrap(),
  });
  // Graceful shutdown → stop() (persistent-by-default auto-snapshots on stop),
  // so the microVM tier actually persists across restarts (P20 HIGH-2).
  const shutdown = () => {
    void handle.stop().finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return { host: handle.host, label: `vercel-sandbox(microvm:${handle.name})` };
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
  remoteCwd: process.env.GENESIS_REMOTE_CWD,
});

console.log(
  `[genesis] local channel → http://localhost:${port}  (workspace: ${workspaceRoot}, store: ${label}, host: ${hostLabel})`,
);
export default { port, fetch: app.fetch, websocket };
