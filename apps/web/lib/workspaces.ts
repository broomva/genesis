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
   *  available. `false` → the repo dir vanished; binding a new thread to it errors
   *  at run time. The ACTUAL enforcement is the server dispatch guard; the UI
   *  surfaces `false` (the workspace manager badges it "unavailable"; the composer
   *  picker disables it) so the user isn't surprised by the server rejection. */
  available?: boolean;
  /** Can a session on this workspace actually get a per-session worktree (BRO-1657)?
   *  Computed server-side, folding the per-workspace `noWorktree` (BRO-1512) AND the
   *  global default — so the launcher's root/worktree toggle offers "worktree" only
   *  where it's real. Absent on an older engine → treat as capable (the server still
   *  enforces the safety downgrade); `false` → the toggle is forced to Root. */
  worktreeCapable?: boolean;
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
              // Worktree capability (BRO-1657) — preserve when the engine reports it;
              // an older engine omits it → undefined → the launcher treats as capable.
              ...(typeof w.worktreeCapable === "boolean"
                ? { worktreeCapable: w.worktreeCapable }
                : {}),
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

// ─── Filesystem navigator (BRO-1673) — the browse-to-pick backend for add-by-path ──

/** A navigable subdirectory returned by the browse endpoint. `path` is absolute — an
 *  OWNER-ONLY surface (the BFF gates /api/workspaces/browse to the owner). */
export interface BrowseEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

/** One level of the filesystem navigator (mirrors the engine's BrowseResult). */
export interface BrowseResult {
  /** The current directory (absolute), or null at the synthetic multi-root top. */
  path: string | null;
  /** The parent to navigate up to (null at a root / the synthetic top). */
  parent: string | null;
  /** Can the CURRENT `path` be registered as a workspace? (false at the synthetic top). */
  registerable: boolean;
  /** Subdirectories to descend into. */
  entries: BrowseEntry[];
  /** True when the directory had more subdirectories than the server cap. */
  truncated: boolean;
}

export type BrowseOutcome = { ok: true; result: BrowseResult } | { ok: false; error: string };

/** Browse the host filesystem for a folder to register (owner-only). No `path` → the
 *  server's starting level (a single add-root's contents, or the roots list). Returns the
 *  engine's safe message on a rejected/inaccessible path; every field is defensively
 *  validated so a malformed body can't crash the picker. */
export async function browseForAdd(path?: string, signal?: AbortSignal): Promise<BrowseOutcome> {
  try {
    const qs = path ? `?path=${encodeURIComponent(path)}` : "";
    const res = await fetch(`/api/workspaces/browse${qs}`, { signal });
    const data = (await res.json().catch(() => ({}))) as Partial<BrowseResult> & {
      error?: unknown;
    };
    if (!res.ok) {
      const error =
        typeof data.error === "string" && data.error ? data.error : "could not browse this folder";
      return { ok: false, error };
    }
    return {
      ok: true,
      result: {
        path: typeof data.path === "string" ? data.path : null,
        parent: typeof data.parent === "string" ? data.parent : null,
        registerable: data.registerable === true,
        entries: Array.isArray(data.entries)
          ? data.entries.filter(
              (e): e is BrowseEntry =>
                typeof e?.name === "string" &&
                e.name.length > 0 &&
                typeof e?.path === "string" &&
                e.path.length > 0,
            )
          : [],
        truncated: data.truncated === true,
      },
    };
  } catch {
    return { ok: false, error: "network error — could not browse" };
  }
}

/** The outcome of an add — the new workspace on success, or the engine's SAFE
 *  400 message on a rejected pick (bad name / traversal / not-a-repo). */
export type AddWorkspaceResult = { ok: true; workspace: Workspace } | { ok: false; error: string };

/** POST a workspace-add body to the BFF and normalize the outcome. Shared by the
 *  two add shapes (BRO-1629): `{pick}` (discover→pick, slice 3) and `{gitUrl}`
 *  (add-by-git-URL, slice 5). The engine owns all validation and returns a safe 400
 *  message on rejection, which the BFF relays verbatim. Upholds the non-empty
 *  id+name invariant the rest of this file enforces (an empty id would later render
 *  <SelectItem value=""> and Radix throws synchronously, white-screening). */
async function postWorkspace(body: Record<string, string>): Promise<AddWorkspaceResult> {
  try {
    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<Workspace> & { error?: unknown };
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

/** Register a picked directory as a workspace (POST /workspaces {pick}). The client
 *  sends only the directory NAME; the engine derives + validates the path. */
export function addWorkspace(pick: string): Promise<AddWorkspaceResult> {
  return postWorkspace({ pick });
}

/** Register a workspace by cloning a public git URL (POST /workspaces {gitUrl},
 *  BRO-1629 slice 5). The client sends only the URL; the engine validates it
 *  (https-only + host allowlist + no credentials — SSRF-safe), clones it into the
 *  allow-root, and registers it. A rejected URL comes back as the engine's safe 400. */
export function addWorkspaceByUrl(gitUrl: string): Promise<AddWorkspaceResult> {
  return postWorkspace({ gitUrl });
}

/** Register an EXISTING folder by its absolute path (POST /workspaces {path},
 *  BRO-1663) — owner-only (the BFF rejects the agent principal). For folders
 *  OUTSIDE the discovery allow-root (e.g. ~/broomva). The engine sandboxes the
 *  path to the server's add-roots (default $HOME) + resolves symlinks; a rejected
 *  path comes back as the engine's safe 400. rootPath never returns to the client. */
export function addWorkspaceByPath(path: string): Promise<AddWorkspaceResult> {
  return postWorkspace({ path });
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
