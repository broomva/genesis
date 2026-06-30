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
        ? data.workspaces.filter(
            (w): w is Workspace =>
              typeof w?.id === "string" && w.id.length > 0 && typeof w?.name === "string",
          )
        : [],
      defaultWorkspace: typeof data.defaultWorkspace === "string" ? data.defaultWorkspace : "",
    };
  } catch {
    return EMPTY;
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
