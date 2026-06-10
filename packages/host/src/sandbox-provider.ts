// VercelSandboxHostProvider — a HostProvider that gives each session its OWN
// persistent Vercel Sandbox microVM (Sandbox.getOrCreate({ name: sessionId })).
// Same-named sandbox = same filesystem/cloned-repo/deps across turns + restarts,
// composing with the Phase-2 durable store. Handles are cached + kept warm.

import type { HostLease, HostProvider, HostSession } from "./host-provider";
import {
  type VercelSandboxHandle,
  type VercelSandboxOptions,
  createVercelSandboxHost,
} from "./sandbox-factory";

/** Build the env that points the Claude Code CLI at Vercel AI Gateway.
 *  ANTHROPIC_API_KEY MUST be empty — Claude Code checks it first and would use
 *  it over ANTHROPIC_AUTH_TOKEN. The token may be an AI_GATEWAY_API_KEY or a
 *  VERCEL_OIDC_TOKEN (both authenticate the gateway). */
export function aiGatewayEnv(token: string, model?: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: "",
    ...(model ? { ANTHROPIC_MODEL: model } : {}),
  };
}

export interface VercelSandboxProviderOptions
  extends Omit<VercelSandboxOptions, "sessionName" | "reuse"> {
  /** Map a session → sandbox name. Default: the session id (one VM per self). */
  nameFor?: (s: HostSession) => string;
  /** Working dir inside the VM, surfaced on every lease (default /vercel/sandbox). */
  remoteCwd?: string;
  /** Stop the VM after each turn instead of keeping it warm (default: keep warm). */
  stopAfterTurn?: boolean;
}

/** The sandbox-creation function (injectable for tests; defaults to the real one). */
export type SandboxCreator = (opts: VercelSandboxOptions) => Promise<VercelSandboxHandle>;

export class VercelSandboxHostProvider implements HostProvider {
  /** Cache the in-flight/created handle PROMISE per name → dedupes concurrent
   *  first-creates for the same session. */
  private readonly handles = new Map<string, Promise<VercelSandboxHandle>>();
  private readonly create: SandboxCreator;

  constructor(
    private readonly opts: VercelSandboxProviderOptions = {},
    create: SandboxCreator = createVercelSandboxHost,
  ) {
    this.create = create;
  }

  async resolveHost(session: HostSession): Promise<HostLease> {
    const name = (this.opts.nameFor ?? ((s) => s.id))(session);
    let handle = this.handles.get(name);
    if (!handle) {
      handle = this.create({ ...this.opts, sessionName: name, reuse: true }).catch((e) => {
        // failed create must not poison the cache (next turn retries)
        this.handles.delete(name);
        throw e;
      });
      this.handles.set(name, handle);
    }
    const h = await handle;
    return {
      host: h.host,
      remoteCwd: this.opts.remoteCwd,
      release: this.opts.stopAfterTurn
        ? async () => {
            this.handles.delete(name);
            await h.stop().catch(() => {});
          }
        : undefined,
    };
  }

  /** Stop every warm sandbox (call on graceful shutdown). */
  async shutdown(): Promise<void> {
    const all = [...this.handles.entries()];
    this.handles.clear();
    await Promise.all(
      all.map(async ([, p]) => {
        try {
          await (await p).stop();
        } catch {
          /* best-effort */
        }
      }),
    );
  }
}
