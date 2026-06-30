// Boot-time workspace discovery (BRO-1627) — extracted from index.ts so the
// edge logic (slug collisions, id validation, JSON parsing) is unit-testable
// without booting the server. The Supervisor merges these (default first) into
// its in-memory registry; nothing here touches the DB.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "@genesis/core";

/** The same id charset the chat-sdk parse enforces on the wire — an id that fails
 *  it would be rejected as `workspaceId`, so a workspace carrying it could never
 *  be selected (P20 S3). Scanned ids always pass (they're `ws-<slug>`). */
const WS_ID_RE = /^[A-Za-z0-9][\w.-]*$/;

/** id-safe slug for a discovered workspace name (matches WS_ID_RE once prefixed
 *  with `ws-`). Exported for tests. */
export function slugifyWorkspace(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "ws"
  );
}

/** Deterministic short hash (djb2) → 6 hex chars, to disambiguate slug collisions
 *  by path rather than silently dropping a repo (P20 S2). */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

/** One discovered repo under the projects root. */
export interface ScannedRepo {
  name: string;
  rootPath: string;
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Default scan: immediate children of `root` that are git repos. Follows a
 *  symlink-to-dir (a common dev setup symlinks repos into the root; withFileTypes
 *  reports a symlink as !isDirectory, so it's checked explicitly — P20 N3). */
export function scanGitRepos(root: string): ScannedRepo[] {
  try {
    const out: ScannedRepo[] = [];
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      const rootPath = join(root, ent.name);
      const isDir = ent.isDirectory() || (ent.isSymbolicLink() && safeIsDir(rootPath));
      if (!isDir) continue;
      if (!existsSync(join(rootPath, ".git"))) continue; // git repos only
      out.push({ name: ent.name, rootPath });
    }
    return out;
  } catch (e) {
    console.warn(
      `[genesis] GENESIS_PROJECTS_ROOT scan failed (${root}): ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
}

/**
 * Discover selectable workspaces beyond the default (BRO-1627) from env:
 *  - GENESIS_PROJECTS_ROOT → `scan(root)` (default: {@link scanGitRepos}) becomes
 *    single-repo workspaces (isGitRepo, inheriting the global noWorktree).
 *  - GENESIS_WORKSPACES → JSON `[{id,name,rootPath,noWorktree?,isGitRepo?}]`,
 *    appended/overriding by id — the escape hatch to declare a nested-monorepo
 *    workspace with `noWorktree:true`.
 * `env`/`scan` are injected so the edge logic is testable. The DEFAULT workspace
 * is NOT added here (the Supervisor adds it, reserving its id). Returns [] when
 * neither env is set → today's single-workspace behavior.
 */
export function discoverWorkspaces(
  env: Record<string, string | undefined>,
  scan: (root: string) => ScannedRepo[] = scanGitRepos,
): Workspace[] {
  const byId = new Map<string, Workspace>();
  const root = env.GENESIS_PROJECTS_ROOT;
  if (root) {
    // Sort by rootPath so the clean-id-vs-disambiguated-id assignment is
    // deterministic regardless of filesystem readdir order (P20 S2).
    const repos = [...scan(root)].sort((a, b) => (a.rootPath < b.rootPath ? -1 : 1));
    for (const repo of repos) {
      let id = `ws-${slugifyWorkspace(repo.name)}`;
      if (byId.has(id)) {
        const disambiguated = `${id}-${shortHash(repo.rootPath)}`;
        console.warn(
          `[genesis] workspace id "${id}" collides (${repo.rootPath}); using "${disambiguated}".`,
        );
        id = disambiguated;
      }
      byId.set(id, { id, name: repo.name, rootPath: repo.rootPath, isGitRepo: true });
    }
  }
  const json = env.GENESIS_WORKSPACES;
  if (json) {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (Array.isArray(parsed)) {
        for (const w of parsed as Array<Record<string, unknown>>) {
          if (
            typeof w?.id !== "string" ||
            typeof w.name !== "string" ||
            typeof w.rootPath !== "string"
          ) {
            continue;
          }
          // Explicit ids must satisfy the wire charset guard, or the chat-sdk parse
          // drops the workspaceId → the picker offers an unselectable workspace
          // (P20 S3). Skip + warn rather than advertise a dead option.
          if (!WS_ID_RE.test(w.id)) {
            console.warn(
              `[genesis] GENESIS_WORKSPACES id "${w.id}" is not a valid workspace id; skipping.`,
            );
            continue;
          }
          byId.set(w.id, {
            id: w.id,
            name: w.name,
            rootPath: w.rootPath,
            isGitRepo: typeof w.isGitRepo === "boolean" ? w.isGitRepo : undefined,
            noWorktree: typeof w.noWorktree === "boolean" ? w.noWorktree : undefined,
          });
        }
      } else {
        console.warn("[genesis] GENESIS_WORKSPACES must be a JSON array; ignoring.");
      }
    } catch (e) {
      console.warn(
        `[genesis] GENESIS_WORKSPACES is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return [...byId.values()];
}
