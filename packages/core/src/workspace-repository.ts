import type { Workspace } from "./types";

/** The source-of-truth seam for the selectable workspace registry (BRO-1629,
 *  Phase 2.5). Mirrors the `Store` / `ExecutionHost` port instinct: the Supervisor
 *  depends on this interface, not a concrete backing. The default in-memory adapter
 *  reproduces the BRO-1627 env-snapshot registry; the FS adapter (manifest-in-git)
 *  makes it runtime-mutable + host-portable. The Supervisor keeps an in-memory
 *  CACHE (its `workspaceRegistry` Map) hydrated from `list()`, so the per-turn hot
 *  path stays synchronous; mutations write through here and refresh the cache.
 *
 *  Async throughout so an FS/DB adapter can back it. `remove()` only DE-REGISTERS —
 *  it never `rm -rf`s the underlying repo (that authority never leaves an explicit
 *  admin action). */
export interface WorkspaceRepository {
  /** Every registered workspace (the full record, incl. rootPath — server-only). */
  list(): Promise<Workspace[]>;
  /** One workspace by id, or undefined. */
  get(id: string): Promise<Workspace | undefined>;
  /** Register (create-or-update) a workspace. Returns the stored record. */
  register(ws: Workspace): Promise<Workspace>;
  /** De-register a workspace (idempotent; a missing id is a no-op). */
  remove(id: string): Promise<void>;
}

/** In-memory adapter (default) — the registry lives in a Map, seeded at
 *  construction. Behaviourally identical to the BRO-1627 boot registry when seeded
 *  from env; also the unit-test backing (keeps the Supervisor DB/FS-free). */
export class InMemoryWorkspaceRepository implements WorkspaceRepository {
  private readonly ws = new Map<string, Workspace>();

  constructor(seed: readonly Workspace[] = []) {
    for (const w of seed) this.ws.set(w.id, w);
  }

  async list(): Promise<Workspace[]> {
    return [...this.ws.values()];
  }

  async get(id: string): Promise<Workspace | undefined> {
    return this.ws.get(id);
  }

  async register(ws: Workspace): Promise<Workspace> {
    this.ws.set(ws.id, ws);
    return ws;
  }

  async remove(id: string): Promise<void> {
    this.ws.delete(id);
  }
}
