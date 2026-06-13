import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "@genesis/core";
import { createPgliteStore, createPostgresStore } from "@genesis/db";
import {
  type HostProvider,
  type SandboxNetworkPolicy,
  VercelSandboxHostProvider,
  aiGatewayEnv,
  allowListOmitsGatewayHost,
} from "@genesis/host";
import { type InteractiveEngine, createInteractiveEngine } from "@genesis/runner";
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
    const policy = JSON.parse(raw) as SandboxNetworkPolicy;
    // A custom allow-list (array OR record-of-host→rules form) that omits the
    // gateway host silently breaks the agent's LLM route. Warn loudly (don't
    // hard-fail — the user may proxy egress elsewhere).
    if (allowListOmitsGatewayHost(policy)) {
      console.warn(
        "[genesis] WARNING: GENESIS_NETWORK_POLICY allow-list omits ai-gateway.vercel.sh — " +
          "the agent may be unable to reach the LLM via the gateway.",
      );
    }
    return policy;
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
  // Treat a BLANK env var as missing — `??` only falls back on undefined, so a
  // set-but-empty AI_GATEWAY_API_KEY would otherwise shadow VERCEL_OIDC_TOKEN.
  const token =
    (process.env.AI_GATEWAY_API_KEY || "").trim() || (process.env.VERCEL_OIDC_TOKEN || "").trim();
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

// Engine selection (BRO-1488): GENESIS_ENGINE=interactive → one persistent
// INTERACTIVE Claude Code session per thread (exempt subscription class) via
// @genesis/session-host. Default → the print engine (`claude -p`, metered).
// Local-host only — the interactive engine drives tmux + the local binary.
let engine: InteractiveEngine | undefined;
let engineLabel = "print(claude -p)";
if (process.env.GENESIS_ENGINE === "interactive") {
  if (process.env.GENESIS_HOST === "vercel") {
    console.error(
      "[genesis] GENESIS_ENGINE=interactive is local-host only (tmux + local claude); " +
        "unset GENESIS_HOST or drop GENESIS_ENGINE.",
    );
    process.exit(1);
  }
  const pin = process.env.GENESIS_CLAUDE_PIN;
  const rawTurnTimeout = Number(process.env.GENESIS_TURN_TIMEOUT_MS);
  engine = createInteractiveEngine({
    pin,
    turnTimeoutMs:
      Number.isFinite(rawTurnTimeout) && rawTurnTimeout > 0 ? rawTurnTimeout : undefined,
  });
  engineLabel = `interactive(exempt${pin ? `, pin ${pin}` : ", PATH claude"})`;
  // P20 (BRO-1488 round-2 B2): the interactive engine's default permission
  // policy is allow-all — the same posture as --dangerously-skip-permissions,
  // but selected by GENESIS_ENGINE alone, so the extraArgs-based warning in
  // server.ts never fires. Mirror it here.
  if (!process.env.GENESIS_TOKEN) {
    console.warn(
      "[genesis] WARNING: the interactive engine auto-allows agent tool permissions and /message is " +
        "unauthenticated. Bind to localhost only, or set GENESIS_TOKEN.",
    );
  }
  // Kill live agent tmux sessions + the control socket on shutdown. (Mutually
  // exclusive with the vercel provider's handlers — guarded above.) A hung
  // kill/stop must not wedge SIGTERM — 5s watchdog forces the exit.
  const engineShutdown = () => {
    setTimeout(() => process.exit(1), 5_000).unref();
    void engine?.shutdown().finally(() => process.exit(0));
  };
  process.once("SIGTERM", engineShutdown);
  process.once("SIGINT", engineShutdown);
}

const { app, websocket } = build({
  workspaceRoot,
  extraArgs: process.env.GENESIS_AGENT_ARGS?.split(" ").filter(Boolean),
  token: process.env.GENESIS_TOKEN,
  store,
  hostProvider,
  remoteCwd: process.env.GENESIS_REMOTE_CWD,
  run: engine?.run,
  control: engine, // InteractiveEngine satisfies EngineControl (reset/interrupt/status)
  // Run directly in the workspace (no worktree) — required for nested-repo
  // workspaces like ~/broomva (BRO-1512). Interactive engine only.
  noWorktree: process.env.GENESIS_NO_WORKTREE === "1",
});

// Bun.serve idles a connection after `idleTimeout` seconds of NO bytes and closes
// it. The default is 10s — far too short for `/api/chat`, where a microVM tier
// spends seconds-to-minutes creating/bootstrapping a sandbox before the agent
// emits its first phase event. Use Bun's max (255s) so those gaps don't sever the
// SSE stream. (A periodic heartbeat would lift this ceiling for very-long quiet
// runs — tracked as a follow-up; agent phase events provide liveness meanwhile.)
// Guard against a non-numeric env value: Number("abc")=NaN → Bun.serve THROWS at
// boot (crash-loop). Fall back to the safe default, matching this file's other
// defensive env parsing. (0 = disable timeout; negative → default.)
const rawIdle = Number(process.env.GENESIS_IDLE_TIMEOUT);
const idleTimeout = Number.isInteger(rawIdle) && rawIdle >= 0 ? Math.min(255, rawIdle) : 255;

console.log(
  `[genesis] local channel → http://localhost:${port}  (workspace: ${workspaceRoot}, store: ${label}, host: ${hostLabel}, engine: ${engineLabel}, idleTimeout: ${idleTimeout}s)`,
);
export default { port, idleTimeout, fetch: app.fetch, websocket };
