import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Store } from "@genesis/core";
import { reconcileInterruptedSessions } from "@genesis/core";
import { createPgliteStore, createPostgresStore } from "@genesis/db";
import {
  type HostProvider,
  type SandboxNetworkPolicy,
  VercelSandboxHostProvider,
  aiGatewayEnv,
  allowListOmitsGatewayHost,
} from "@genesis/host";
import {
  type InteractiveEngine,
  RunLogger,
  createInteractiveEngine,
  runCodex,
} from "@genesis/runner";
import { build } from "./server";
import { FsWorkspaceRepository } from "./workspace-repository-fs";
import { discoverWorkspaces } from "./workspaces";

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

// Selectable workspaces beyond the default (BRO-1627) — discovered from
// GENESIS_PROJECTS_ROOT / GENESIS_WORKSPACES. The edge logic lives in ./workspaces
// so it's unit-testable without booting this server module.
const workspaces = discoverWorkspaces(process.env);

// Durable, runtime-mutable registry (BRO-1629, Phase 2.5) — a directory of JSON
// manifests, git-logged if it's a repo. OPT-IN via GENESIS_WORKSPACES_DIR: env
// discovery SEEDS it on first empty boot, then it's the source (survives restart,
// editable at runtime). Unset → in-memory, re-read from env each boot (the
// BRO-1627 behaviour) — so existing deploys are unchanged until they opt in.
const workspaceRepository = process.env.GENESIS_WORKSPACES_DIR
  ? new FsWorkspaceRepository(process.env.GENESIS_WORKSPACES_DIR)
  : undefined;

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

// Boot reconciliation (BRO-1530): a turn interrupted by a process crash (deploy,
// OOM, port relocation) leaves phase="running" in the durable store. Extend the
// runner's F20 invariant across the crash boundary — reset orphaned turns to
// blocked so /status is truthful. Resume continuity is unaffected (agentSessionId
// is durable; the next turn resumes the conversation).
try {
  const { reconciled, threadIds } = await reconcileInterruptedSessions(store);
  if (reconciled > 0) {
    // Cap the logged list so a mass reset (e.g. DB-wide corruption) can't dump
    // an unbounded thread list into the launchd log.
    const shown = threadIds.slice(0, 20).join(", ");
    const more = threadIds.length > 20 ? ` (+${threadIds.length - 20} more)` : "";
    console.log(
      `[genesis] reconciled ${reconciled} interrupted session(s) → blocked: ${shown}${more}`,
    );
  }
} catch (e) {
  // Non-fatal: reconciliation is hygiene, not a boot prerequisite.
  console.error(
    `[genesis] session reconciliation failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
  );
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
// Engine REGISTRY (BRO-1620): `print` is the Supervisor's baseline runner; ALSO
// build the interactive engine when on a LOCAL host, so a thread can select it.
// GENESIS_ENGINE picks the DEFAULT engine new threads inherit when the client
// doesn't request one (interactive only when it was actually built).
let interactiveEngine: InteractiveEngine | undefined;
let engineLabel = "print(claude -p)";
// Interactive needs a TRULY local host (tmux + local claude). Treat only unset
// or "local" as local — a non-vercel REMOTE host must NOT register interactive
// (the interactive runner is local-only; it would fail at dispatch instead of
// falling back to print). CodeRabbit.
const hostMode = process.env.GENESIS_HOST;
const localHost = hostMode === undefined || hostMode === "" || hostMode === "local";
// Per-session trace dir, shared by both engines (BRO-1519/1524).
const runsDir = process.env.GENESIS_RUNS_DIR ?? join(defaultDataDir(), "runs");
mkdirSync(runsDir, { recursive: true });
// Per-event AgentEvent trace, EVERY turn (both engines now coexist, BRO-1620) →
// <sessionId>.events.jsonl. Distinct filename from the interactive engine's richer
// IR RunLogger so the two never collide on one file. Best-effort.
const printTrace = (sessionId: string, event: AgentEvent) => {
  try {
    const file = join(runsDir, `${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}.events.jsonl`);
    appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...event })}\n`);
  } catch {
    // observability must never break a turn
  }
};
console.log(`[genesis] session traces → ${runsDir}`);

if (localHost) {
  const pin = process.env.GENESIS_CLAUDE_PIN;
  const rawTurnTimeout = Number(process.env.GENESIS_TURN_TIMEOUT_MS);
  // Full session observability (BRO-1519): every IR event + engine diagnostic
  // → per-session JSONL trace + structured console lines (to the launchd log).
  const runLogger = new RunLogger({ dir: runsDir });
  interactiveEngine = createInteractiveEngine({
    pin,
    turnTimeoutMs:
      Number.isFinite(rawTurnTimeout) && rawTurnTimeout > 0 ? rawTurnTimeout : undefined,
    observer: (event) => runLogger.observe(event),
  });
  engineLabel = `print + interactive(exempt${pin ? `, pin ${pin}` : ", PATH claude"})`;
  // P20 (BRO-1488 round-2 B2): the interactive engine's default permission policy
  // is allow-all (== --dangerously-skip-permissions) — warn if /message is open.
  if (!process.env.GENESIS_TOKEN) {
    console.warn(
      "[genesis] WARNING: the interactive engine auto-allows agent tool permissions and /message is " +
        "unauthenticated. Bind to localhost only, or set GENESIS_TOKEN.",
    );
  }
  // Kill live agent tmux sessions + the control socket on shutdown. A hung
  // kill/stop must not wedge SIGTERM — 5s watchdog forces the exit.
  const engineShutdown = () => {
    setTimeout(() => process.exit(1), 5_000).unref();
    void interactiveEngine?.shutdown().finally(() => process.exit(0));
  };
  process.once("SIGTERM", engineShutdown);
  process.once("SIGINT", engineShutdown);
} else if (process.env.GENESIS_ENGINE === "interactive") {
  console.error(
    "[genesis] GENESIS_ENGINE=interactive is local-host only (tmux + local claude); " +
      "unset GENESIS_HOST, set GENESIS_HOST=local, or drop GENESIS_ENGINE.",
  );
  process.exit(1);
}

// Codex engine (BRO-1621) — the second one-shot harness (OpenAI codex CLI). Soft
// -detected: registered only when the `codex` binary is on PATH AND the host is
// local (the runner spawns codex on THIS box, so detecting it here proves it is
// where dispatch runs — same locality constraint as interactive, minus tmux).
// codex drives by ChatGPT subscription (`~/.codex/auth.json`); the user runs
// `codex login --device-auth` on the box once. No control surface (one-shot,
// like print) → runners only, never `controls`. Absent codex → silently skipped,
// so a stale request for engine "codex" falls back to the default at dispatch.
const codexBin = localHost ? Bun.which("codex") : null;
const codexAvailable = codexBin !== null;
// The engine registry the Supervisor binds per thread (BRO-1620). print is the
// Supervisor's built-in baseline; these are the additional engines.
const runners: Record<string, typeof runCodex> = {};
if (interactiveEngine) runners.interactive = interactiveEngine.run;
if (codexAvailable) {
  runners.codex = runCodex;
  // Don't log the absolute binary path (filesystem-layout leak) — just the fact.
  engineLabel += " + codex(exec)";
}

// Default engine new threads inherit when the client omits one — GENESIS_ENGINE,
// honored for ANY engine that was actually built (interactive / codex), else
// print (CodeRabbit: a codex-available box with GENESIS_ENGINE=codex must NOT
// silently default to print). A requested-but-unavailable default warns + falls
// back; the Supervisor's own guard is the final net (it re-resolves to print if
// the named default isn't registered).
const requestedDefault = process.env.GENESIS_ENGINE;
let defaultEngine = "print";
if (requestedDefault === "interactive" && interactiveEngine) defaultEngine = "interactive";
else if (requestedDefault === "codex" && codexAvailable) defaultEngine = "codex";
else if (requestedDefault === "codex" && !codexAvailable) {
  console.warn(
    "[genesis] GENESIS_ENGINE=codex but codex was not found on PATH; defaulting to print.",
  );
}

const { app, websocket } = build({
  workspaceRoot,
  // Selectable workspaces beyond the default (BRO-1627) — empty unless an operator
  // sets GENESIS_PROJECTS_ROOT / GENESIS_WORKSPACES (then the picker self-shows).
  // These SEED the repository below when it's empty (BRO-1629).
  workspaces,
  // Durable, runtime-mutable registry source (BRO-1629) — FS manifests when
  // GENESIS_WORKSPACES_DIR is set, else undefined → in-memory (env each boot).
  workspaceRepository,
  // Allow-root for discover→pick self-serve add (BRO-1629) — GET /workspaces/
  // available scans it; POST /workspaces registers a picked dir under it.
  projectsRoot: process.env.GENESIS_PROJECTS_ROOT,
  extraArgs: process.env.GENESIS_AGENT_ARGS?.split(" ").filter(Boolean),
  token: process.env.GENESIS_TOKEN,
  store,
  hostProvider,
  remoteCwd: process.env.GENESIS_REMOTE_CWD,
  // The registry: print is the Supervisor baseline; interactive + codex when
  // available (BRO-1620/1621).
  runners: Object.keys(runners).length > 0 ? runners : undefined,
  controls: interactiveEngine ? { interactive: interactiveEngine } : undefined,
  defaultEngine,
  // Run directly in the workspace (no worktree) — required for nested-repo
  // workspaces like ~/broomva (BRO-1512). Honored by both engines.
  noWorktree: process.env.GENESIS_NO_WORKTREE === "1",
  trace: printTrace, // per-event JSONL trace (BRO-1524/1620)
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
