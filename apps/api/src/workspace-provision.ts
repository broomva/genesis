import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Workspace } from "@genesis/core";
import { scanGitRepos, slugifyWorkspace } from "./workspaces";

/** A rejected client PICK (bad name / traversal / non-git / escape). Its message is
 *  SAFE to echo to the client (400); any OTHER error from registration is internal
 *  (FS EACCES/ENOSPC with an absolute path) and must NOT be echoed (P20 Forge SF2). */
export class WorkspaceValidationError extends Error {}

// Discover→pick provisioning (BRO-1629, Phase 2.5 · slice 2). The security spine:
// the CLIENT NEVER NAMES A FILESYSTEM PATH. It picks a directory NAME surfaced by
// GET /workspaces/available (repos under the admin allow-root); the server derives
// + validates the rootPath inside the allow-root. A rootPath is arbitrary-location
// code execution + `../` traversal — filesystem authority never leaves the server.

export interface AvailableRepo {
  /** The directory name (what the client picks). */
  name: string;
  /** The workspace id it would register as. */
  id: string;
}

/** Deterministic short hash (djb2) → 6 hex, to disambiguate slug collisions. */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

/** Git repos under the allow-root that aren't already registered (by derived id). */
export function availableWorkspaces(
  allowRoot: string | undefined,
  registeredIds: ReadonlySet<string>,
): AvailableRepo[] {
  if (!allowRoot) return [];
  return scanGitRepos(allowRoot)
    .map((r) => ({ name: r.name, id: `ws-${slugifyWorkspace(r.name)}` }))
    .filter((r) => !registeredIds.has(r.id));
}

/** Resolve a client PICK (a directory name under the allow-root) into a full
 *  Workspace — the server derives + validates the rootPath. Throws on an invalid
 *  pick (missing allow-root, unsafe name, escapes the root, not a dir, not a git
 *  repo). `takenIds` disambiguates a slug collision deterministically (never
 *  overwrites an existing workspace with a different path). */
export function resolvePick(
  allowRoot: string | undefined,
  pick: unknown,
  takenIds: ReadonlySet<string>,
): Workspace {
  if (!allowRoot) throw new WorkspaceValidationError("no projects root configured");
  if (
    typeof pick !== "string" ||
    pick.length === 0 ||
    pick.includes("/") ||
    pick.includes("\\") ||
    pick.includes("..") ||
    pick.startsWith(".")
  ) {
    throw new WorkspaceValidationError(
      "invalid pick (must be a plain directory name under the projects root)",
    );
  }
  const base = resolve(allowRoot);
  const rootPath = resolve(allowRoot, pick);
  if (rootPath !== base && !rootPath.startsWith(base + sep)) {
    throw new WorkspaceValidationError("pick escapes the projects root");
  }
  if (!existsSync(rootPath))
    throw new WorkspaceValidationError(`pick "${pick}" not found under the projects root`);
  if (!existsSync(resolve(rootPath, ".git")))
    throw new WorkspaceValidationError(`"${pick}" is not a git repository`);
  // HARD boundary (P20 Forge SF1): the lexical startsWith is symlink-blind, and the
  // scan deliberately follows symlink-to-dir — so a symlink inside the allow-root
  // pointing OUTSIDE would store a path lexically-inside but real-outside, letting
  // the agent cwd off-boundary. Re-check the REAL paths so the allow-root is a hard
  // sandbox, not a lexical one.
  const realRoot = realpathSync(base);
  const realPath = realpathSync(rootPath);
  if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) {
    throw new WorkspaceValidationError("pick resolves outside the projects root (symlink)");
  }
  let id = `ws-${slugifyWorkspace(pick)}`;
  if (takenIds.has(id)) id = `${id}-${shortHash(rootPath)}`;
  return { id, name: pick, rootPath, isGitRepo: true };
}
