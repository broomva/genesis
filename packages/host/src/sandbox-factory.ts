// Factory for VercelSandboxHost — lazy-imports @vercel/sandbox so the SDK loads
// only when the microVM tier is actually used (LocalHost/VpsHost stay dep-light).
//
// Auth (read from env by the SDK): VERCEL_OIDC_TOKEN (automatic on Vercel) or an
// access token (VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID) elsewhere.

import { type SandboxLike, VercelSandboxHost } from "./sandbox";

export type SandboxRuntime = "node26" | "node24" | "node22" | "python3.13";

/** Egress firewall. Strings are coarse; the object form is deny-by-default with
 *  an allow-list (the BRO-1360 posture: deny all except what the agent needs —
 *  e.g. api.anthropic.com). Mirrors the @vercel/sandbox NetworkPolicy shape. */
export type SandboxNetworkPolicy =
  | "deny-all"
  | "allow-all"
  | { allow?: string[]; subnets?: { allow?: string[]; deny?: string[] } };

export interface VercelSandboxOptions {
  /** Sandbox name = continuity key. Same name → same persistent microVM
   *  (filesystem/cloned-repo/deps survive), composing with the Phase-2 store. */
  sessionName?: string;
  /** Clone a git repo into the VM at creation (source: { type: 'git' }). */
  gitUrl?: string;
  gitRevision?: string;
  /** Private-repo credentials for the git source. */
  gitUsername?: string;
  gitPassword?: string;
  runtime?: SandboxRuntime;
  /** Boundary-injected KEYED creds (e.g. { ANTHROPIC_API_KEY }) — never the
   *  user's subscription OAuth (2026 ToS on non-owned compute). */
  env?: Record<string, string>;
  /** Egress policy. Default is an allow-list (deny-by-default) permitting only
   *  ai-gateway.vercel.sh (the agent's LLM route) — a pure "deny-all" would block the keyed agent from
   *  reaching the LLM API (and npm during bootstrap), so it is NOT the default
   *  for this tier. Pass "deny-all" explicitly to fully isolate (no agent run). */
  networkPolicy?: SandboxNetworkPolicy;
  /** Session timeout (ms). Vercel default is 5 min; agent runs want more. */
  timeoutMs?: number;
  vcpus?: number;
  /** One-time setup commands after create (e.g. install the coding-agent CLI). */
  bootstrap?: string[][];
  /** Reuse an existing same-named sandbox if present (getOrCreate). */
  reuse?: boolean;
  /** Restore from a prior snapshot id instead of an empty/git workspace. */
  fromSnapshotId?: string;
}

export interface VercelSandboxHandle {
  host: VercelSandboxHost;
  sandbox: SandboxLike;
  /** The sandbox name (continuity key for a later Sandbox.get). */
  name: string;
  stop: () => Promise<void>;
}

// @vercel/sandbox is dynamically imported; typed loosely at the import boundary.
type SandboxModule = any;

function buildSource(o: VercelSandboxOptions) {
  if (o.fromSnapshotId) return { type: "snapshot" as const, snapshotId: o.fromSnapshotId };
  if (o.gitUrl)
    return {
      type: "git" as const,
      url: o.gitUrl,
      ...(o.gitRevision ? { revision: o.gitRevision } : {}),
      ...(o.gitUsername ? { username: o.gitUsername } : {}),
      ...(o.gitPassword ? { password: o.gitPassword } : {}),
    };
  return undefined;
}

/** Default egress allow-list: the agent must reach the Anthropic API, and the
 *  npm registry is needed if bootstrap installs the coding-agent CLI. Everything
 *  else is denied (deny-by-default), satisfying BRO-1360 without bricking runs. */
export const DEFAULT_AGENT_ALLOWLIST: SandboxNetworkPolicy = {
  // the agent reaches the LLM via Vercel AI Gateway (not api.anthropic.com directly);
  // npm registries are for the bootstrap install of the coding-agent CLI.
  allow: ["ai-gateway.vercel.sh", "registry.npmjs.org", "registry.yarnpkg.com"],
};

/** Run one-time bootstrap commands; on failure STOP the sandbox before throwing
 *  so a failed bootstrap never leaks a billed microVM (P20 HIGH-1). */
export async function applyBootstrap(
  sandbox: SandboxLike,
  bootstrap: string[][] | undefined,
): Promise<void> {
  for (const cmd of bootstrap ?? []) {
    if (cmd.length === 0) continue;
    const c = await sandbox.runCommand({ cmd: cmd[0] as string, args: cmd.slice(1), sudo: true });
    const code = c.exitCode ?? -1;
    if (code !== 0) {
      const err = await c.stderr();
      await sandbox.stop().catch(() => {}); // never leak the VM
      throw new Error(`sandbox bootstrap failed (${cmd.join(" ")}): exit ${code}: ${err}`);
    }
  }
}

/** Create (or resume) a Vercel Sandbox and wrap it as a VercelSandboxHost. */
export async function createVercelSandboxHost(
  opts: VercelSandboxOptions = {},
): Promise<VercelSandboxHandle> {
  const mod: SandboxModule = await import("@vercel/sandbox");
  const Sandbox = mod.Sandbox;

  const createParams: Record<string, unknown> = {
    runtime: opts.runtime ?? "node24",
    networkPolicy: opts.networkPolicy ?? DEFAULT_AGENT_ALLOWLIST,
    ...(opts.sessionName ? { name: opts.sessionName } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    ...(opts.vcpus ? { resources: { vcpus: opts.vcpus } } : {}),
  };
  const source = buildSource(opts);
  if (source) createParams.source = source;

  const sandbox: SandboxLike =
    opts.reuse && opts.sessionName && typeof Sandbox.getOrCreate === "function"
      ? await Sandbox.getOrCreate(createParams)
      : await Sandbox.create(createParams);

  // One-time bootstrap, with stop-on-failure so we never leak a billed VM.
  await applyBootstrap(sandbox, opts.bootstrap);

  const name: string = (sandbox as { name?: string }).name ?? opts.sessionName ?? "";
  return {
    host: new VercelSandboxHost(sandbox),
    sandbox,
    name,
    stop: async () => {
      await sandbox.stop();
    },
  };
}
