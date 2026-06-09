import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "@genesis/core";
import { createPgliteStore, createPostgresStore } from "@genesis/db";
import {
  type HostProvider,
  type SandboxNetworkPolicy,
  VercelSandboxHostProvider,
  aiGatewayEnv,
} from "@genesis/host";
import { build } from "./server";

const defaultDataDir = () =>
  process.env.GENESIS_DATA_DIR ?? join(homedir() || tmpdir(), ".genesis", "data");

/** Parse GENESIS_NETWORK_POLICY: "deny-all" | "allow-all" | a JSON allow-list
 *  object. Default (undefined) → the factory's deny-by-default agent allow-list
 *  (ai-gateway.vercel.sh + npm). A blanket "deny-all" would block the agent from
 *  the LLM via the gateway, so we warn loudly when it is set explicitly. */
function parseNetworkPolicy(): SandboxNetworkPolicy | undefined {
  const raw = process.env.GENESIS_NETWORK_POLICY;
  if (!raw) return undefined;
  if (raw === "deny-all") {
    console.warn(
      "[genesis] WARNING: networkPolicy=deny-all blocks egress to ai-gateway.vercel.sh — " +
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

/** Pick the host provider. GENESIS_HOST=vercel → a per-session microVM provider
 *  (Vercel Sandbox): each chat thread gets its OWN Firecracker VM
 *  (Sandbox.getOrCreate({name: sessionId})), deny-by-default allow-list egress,
 *  and the agent routed through Vercel AI Gateway (ANTHROPIC_BASE_URL +
 *  ANTHROPIC_AUTH_TOKEN). The gateway token is AI_GATEWAY_API_KEY or, falling
 *  back, VERCEL_OIDC_TOKEN (both authenticate the gateway AND the sandbox).
 *  Default → undefined (Supervisor uses LocalHost). */
function selectHostProvider(): { provider?: HostProvider; label: string } {
  if (process.env.GENESIS_HOST !== "vercel") return { provider: undefined, label: "local" };
  const token = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN;
  if (!token) {
    // The agent's LLM route is keyed — fail fast at boot, not mid-run.
    throw new Error(
      "GENESIS_HOST=vercel needs AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN " +
        "(routes the sandboxed agent through Vercel AI Gateway). Run `vercel env pull`.",
    );
  }
  const provider = new VercelSandboxHostProvider({
    gitUrl: process.env.GENESIS_GIT_URL,
    runtime: "node24",
    networkPolicy: parseNetworkPolicy(),
    timeoutMs: Number(process.env.GENESIS_SANDBOX_TIMEOUT_MS ?? 45 * 60 * 1000),
    remoteCwd: process.env.GENESIS_REMOTE_CWD,
    env: aiGatewayEnv(token, process.env.GENESIS_MODEL),
    bootstrap: parseBootstrap(),
  });
  // Graceful shutdown → stop all warm sandboxes (persistent-by-default → they
  // auto-snapshot on stop, so each session resumes on the next message).
  const shutdown = () => {
    void provider.shutdown().finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return { provider, label: "vercel-sandbox(microvm:per-session)" };
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

let hostProvider: HostProvider | undefined;
let hostLabel: string;
try {
  ({ provider: hostProvider, label: hostLabel } = selectHostProvider());
} catch (e) {
  console.error(
    `[genesis] failed to start the host provider (check Vercel auth): ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(1);
}

const { app, websocket } = build({
  workspaceRoot,
  extraArgs: process.env.GENESIS_AGENT_ARGS?.split(" ").filter(Boolean),
  token: process.env.GENESIS_TOKEN,
  store,
  hostProvider,
  remoteCwd: process.env.GENESIS_REMOTE_CWD,
});

console.log(
  `[genesis] local channel → http://localhost:${port}  (workspace: ${workspaceRoot}, store: ${label}, host: ${hostLabel})`,
);
export default { port, fetch: app.fetch, websocket };
