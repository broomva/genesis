// HostProvider — resolves an ExecutionHost per session, so each chat thread can
// run in its OWN isolated host (e.g. a per-session microVM). The Supervisor
// asks the provider for a lease on every dispatch; the lease optionally carries
// a remoteCwd and a release() called when the turn is done.
//
// Lives in @genesis/host (not core) to avoid a dependency cycle: a provider
// produces ExecutionHosts, so it is a host-layer concept. core depends on host.

import type { ExecutionHost } from "./index";

/** The minimal session shape a provider needs to key a host. */
export interface HostSession {
  id: string;
  threadId: string;
}

export interface HostLease {
  host: ExecutionHost;
  /** Working dir inside the host (microVM); ignored on local/VPS. */
  remoteCwd?: string;
  /** Called after the turn. Omit to keep the host warm across turns. */
  release?: () => Promise<void>;
}

export interface HostProvider {
  resolveHost(session: HostSession): Promise<HostLease>;
}

/** Always returns the same host — the default (preserves pre-provider behavior). */
export class StaticHostProvider implements HostProvider {
  constructor(
    private readonly host: ExecutionHost,
    private readonly remoteCwd?: string,
  ) {}
  async resolveHost(_session?: HostSession): Promise<HostLease> {
    return { host: this.host, remoteCwd: this.remoteCwd };
  }
}
