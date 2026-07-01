// Client helpers for the per-thread workspace picker (BRO-1627). Talks to the
// BFF proxy (/api/workspaces) — never the engine directly. A workspace is the
// repo/dir a thread's agent runs in; the choice binds sticky on the thread's
// first turn (switching = a new thread).

/** The PUBLIC workspace DTO the engine exposes (GET /workspaces) — mirrors the
 *  hardened server shape (packages/core Supervisor.listWorkspaces): id + name +
 *  optional isGitRepo. The filesystem rootPath + the registry-only noWorktree are
 *  deliberately NOT here (they never leave the engine, P20/CodeRabbit #66). */
export interface Workspace {
  id: string;
  name: string;
  isGitRepo?: boolean;
  /** Does the workspace's directory still exist on the server? (BRO-1629 slice 4 /
   *  BRO-1630 RC3.) Computed server-side; absent on older engines → treat as
   *  available. `false` → the repo dir vanished; binding a new thread to it will
   *  error at run time, so the UI marks it and blocks selection. */
  available?: boolean;
}

export interface WorkspaceList {
  workspaces: Workspace[];
  /** The id a thread binds when none is requested (the server's default). */
  defaultWorkspace: string;
}

const EMPTY: WorkspaceList = { workspaces: [], defaultWorkspace: "" };

/** Fetch the selectable workspaces + the server default id. Returns an empty
 *  list on any failure (the picker then self-hides → behavior is unchanged). */
export async function fetchWorkspaces(signal?: AbortSignal): Promise<WorkspaceList> {
  try {
    const res = await fetch("/api/workspaces", { signal });
    if (!res.ok) return EMPTY;
    const data = (await res.json()) as Partial<WorkspaceList>;
    return {
      // Filter to well-formed items on ingest (P20 SHOULD-FIX): a malformed/empty
      // id would later render <SelectItem value=""> and Radix throws synchronously
      // on an empty value, white-screening the composer. Defensive — the hardened
      // server won't, but every untrusted-input path here is rigorous.
      workspaces: Array.isArray(data.workspaces)
        ? data.workspaces
            .filter(
              (w): w is Workspace =>
                typeof w?.id === "string" && w.id.length > 0 && typeof w?.name === "string",
            )
            // Preserve `available` when the engine reports it (BRO-1630 RC3); an
            // older engine omits it → undefined → the UI treats it as available.
            .map((w) => ({
              id: w.id,
              name: w.name,
              ...(typeof w.isGitRepo === "boolean" ? { isGitRepo: w.isGitRepo } : {}),
              ...(typeof w.available === "boolean" ? { available: w.available } : {}),
            }))
        : [],
      defaultWorkspace: typeof data.defaultWorkspace === "string" ? data.defaultWorkspace : "",
    };
  } catch {
    return EMPTY;
  }
}

/** A pickable repo the engine discovered under its allow-root but hasn't
 *  registered yet (GET /workspaces/available, BRO-1629). Only a display name +
 *  the id it would register as — never a filesystem path. */
export interface AvailableRepo {
  id: string;
  name: string;
}

/** Fetch the repos the user can add (git repos under the projects root not yet
 *  registered). Empty on any failure OR when no projects root is configured —
 *  the "Add a project" affordance then shows nothing to add. */
export async function fetchAvailableWorkspaces(signal?: AbortSignal): Promise<AvailableRepo[]> {
  try {
    const res = await fetch("/api/workspaces/available", { signal });
    if (!res.ok) return [];
    const data = (await res.json()) as { available?: unknown };
    return Array.isArray(data.available)
      ? data.available.filter(
          (r): r is AvailableRepo =>
            typeof r?.id === "string" &&
            r.id.length > 0 &&
            typeof r?.name === "string" &&
            r.name.length > 0, // a blank name → blank "Add" button + POST {pick:""} (P20 Forge N2)
        )
      : [];
  } catch {
    return [];
  }
}

/** The outcome of an add — the new workspace on success, or the engine's SAFE
 *  400 message on a rejected pick (bad name / traversal / not-a-repo). */
export type AddWorkspaceResult = { ok: true; workspace: Workspace } | { ok: false; error: string };

/** Register a picked directory as a workspace (POST /workspaces). The client
 *  sends only the directory NAME; the engine derives + validates the path. */
export async function addWorkspace(pick: string): Promise<AddWorkspaceResult> {
  try {
    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pick }),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<Workspace> & { error?: unknown };
    // Uphold the same non-empty id+name invariant fetchWorkspaces /
    // fetchAvailableWorkspaces enforce (CodeRabbit): an empty-string id in an
    // otherwise-ok body would make AddWorkspaceResult.workspace carry the value
    // the rest of the file guards against (Radix <SelectItem value=""> hazard).
    if (
      !res.ok ||
      typeof data.id !== "string" ||
      data.id.length === 0 ||
      typeof data.name !== "string" ||
      data.name.length === 0
    ) {
      const error =
        typeof data.error === "string" && data.error ? data.error : "could not add this project";
      return { ok: false, error };
    }
    return {
      ok: true,
      workspace: {
        id: data.id,
        name: data.name,
        ...(typeof data.isGitRepo === "boolean" ? { isGitRepo: data.isGitRepo } : {}),
      },
    };
  } catch {
    return { ok: false, error: "network error — could not add this project" };
  }
}

/** De-register a workspace (DELETE /workspaces/:id). The repo directory is left
 *  on disk; only the registry entry + its manifest are removed. */
export async function removeWorkspace(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Resolve the workspace a thread should show/send: the thread's bound id if it
 *  has one, else the user's default pref, else the server default — always
 *  clamped to the live list so a stale/removed id never selects nothing. Returns
 *  "" when the list is empty (the picker is hidden then anyway). */
export function resolveWorkspace(
  bound: string | undefined,
  pref: string,
  serverDefault: string,
  list: readonly Workspace[],
): string {
  if (list.length === 0) return "";
  const has = (id: string) => list.some((w) => w.id === id);
  if (bound && has(bound)) return bound;
  if (pref && has(pref)) return pref;
  if (serverDefault && has(serverDefault)) return serverDefault;
  return list[0]?.id ?? "";
}
