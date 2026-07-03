// Filesystem navigator for the "Add a folder" workspace picker (BRO-1673). A single
// pure operation — LIST the immediate SUBDIRECTORIES of a directory that sits under one
// of the add-roots (`pathAddRoots()`, default $HOME) — so the owner can browse to a
// folder and register it instead of typing an absolute path.
//
// SECURITY MODEL. This DELIBERATELY surfaces absolute paths to the client, which the
// rest of the workspace API avoids (Supervisor.listWorkspaces strips rootPath; the
// browser in workspace-fs.ts only ever returns RELATIVE paths). That is safe here for
// the SAME reason add-by-path (BRO-1663 resolvePathAdd) is: the route is OWNER-ONLY at
// the BFF (the machine/agent principal is refused), and the owner already types + sees
// absolute paths. The engine still enforces a HARD sandbox — every path the client
// sends is `realpathSync`'d and RE-checked under an add-root's own realpath, so a
// symlink pointing OUT of the roots can't escape (lexically-inside, really-outside is
// rejected). No listing crosses the add-root boundary; navigation is clamped at it.
//
// Node `fs` (not host.exec) mirrors workspace-fs.ts: the VPS deploy is LocalHost-only,
// so a direct fs read is the simplest correct implementation and keeps the sandbox
// unit-testable in isolation.

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { WorkspaceValidationError } from "./workspace-provision";

/** A navigable subdirectory. Its absolute `path` is an OWNER-ONLY surface (the BFF
 *  gates this route to the owner) — the client descends into it or registers it. */
export interface BrowseEntry {
  /** The subdirectory's own name (a single path segment — never a path). */
  name: string;
  /** Its absolute path (owner-only surface). */
  path: string;
  /** Does it contain a `.git` dir? (a repo the agent could run in directly). */
  isGitRepo: boolean;
}

export interface BrowseResult {
  /** The directory currently being browsed (absolute, realpath'd), or `null` at the
   *  synthetic multi-root top level (nothing to register there). */
  path: string | null;
  /** The parent to navigate up to — CLAMPED at the add-root boundary (`null` when the
   *  current dir IS a root, or at the synthetic top). */
  parent: string | null;
  /** Can the CURRENT `path` be registered as a workspace? `false` at the synthetic top
   *  (the roots list), `true` inside the sandbox. */
  registerable: boolean;
  /** Immediate SUBDIRECTORIES to descend into (dirs only — files aren't pickable). */
  entries: BrowseEntry[];
  /** True when the directory had more subdirectories than the cap. */
  truncated: boolean;
}

/** Max subdirectories returned per listing — bounds the per-entry realpath/stat work so
 *  a huge directory can't pin the single-threaded engine's event loop. */
export const MAX_BROWSE_ENTRIES = 2000;

/** The realpath of whichever add-root CONTAINS (or equals) `realTarget`, else null. A
 *  root that doesn't resolve is skipped. This is the HARD (realpath, not lexical)
 *  boundary — the one load-bearing sandbox check. */
function containingRoot(realTarget: string, roots: readonly string[]): string | null {
  for (const r of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(r);
    } catch {
      continue; // a configured root that doesn't exist can't contain anything
    }
    if (realTarget === realRoot || realTarget.startsWith(realRoot + sep)) return realRoot;
  }
  return null;
}

/** List the immediate subdirectories of `dir` (already realpath'd + proven in-root).
 *  Symlinked dirs are followed but only surfaced when their target stays IN a root
 *  (an out-of-root link is hidden — the same defense-in-depth as workspace-fs.ts). */
function listSubdirs(dir: string, roots: readonly string[]): BrowseResult {
  const root = containingRoot(dir, roots);
  // `dir` is proven in-root by the caller, so `root` is non-null; the parent is null at
  // the root boundary, else the (in-root) parent directory.
  const parent = root && dir !== root ? dirname(dir) : null;

  const candidates: string[] = [];
  let total = 0;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!(d.isDirectory() || d.isSymbolicLink())) continue; // files/sockets aren't pickable
    total++;
    if (candidates.length < MAX_BROWSE_ENTRIES) candidates.push(d.name);
  }
  candidates.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const entries: BrowseEntry[] = [];
  for (const name of candidates) {
    const abs = resolve(dir, name);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      continue; // broken / dangling symlink → skip
    }
    // Keep the sandbox: hide a symlink whose target escapes every root.
    if (!containingRoot(real, roots)) continue;
    try {
      if (!statSync(real).isDirectory()) continue; // symlink-to-file → not a dir → skip
    } catch {
      continue;
    }
    entries.push({ name, path: abs, isGitRepo: existsSync(resolve(real, ".git")) });
  }
  return { path: dir, parent, registerable: true, entries, truncated: total > MAX_BROWSE_ENTRIES };
}

/** Browse for a folder to register. With no `path`: one root → descend straight in (skip
 *  a redundant tap); multiple roots → a synthetic top level listing the roots. With a
 *  `path`: it must be absolute, resolve (symlink-safe) UNDER an add-root, and be a
 *  directory — then its subdirectories are listed. Throws {@link WorkspaceValidationError}
 *  (safe 400, never echoing an unexpected fs path) on any rejection. */
export function browseForAdd(path: unknown, roots: readonly string[]): BrowseResult {
  const usableRoots = roots.filter((r) => existsSync(r));
  if (usableRoots.length === 0)
    throw new WorkspaceValidationError("browsing is not enabled on this server");

  const raw = path === undefined || path === null ? "" : path;
  if (typeof raw !== "string") throw new WorkspaceValidationError("path must be a string");

  // Synthetic top level (no path yet).
  if (raw === "") {
    if (usableRoots.length === 1) return listSubdirs(realpathSync(usableRoots[0]!), usableRoots);
    const rootPaths = usableRoots.map((r) => realpathSync(r)).sort();
    return {
      path: null,
      parent: null,
      registerable: false, // "all roots" isn't a registerable folder
      entries: rootPaths.map((r) => ({ name: r, path: r, isGitRepo: existsSync(resolve(r, ".git")) })),
      truncated: false,
    };
  }

  if (!raw.startsWith("/") || raw.includes("\0"))
    throw new WorkspaceValidationError("path must be an absolute path");
  const normalized = resolve(raw); // normalize `..`/`.` lexically before resolving symlinks
  let realTarget: string;
  try {
    realTarget = realpathSync(normalized);
  } catch {
    throw new WorkspaceValidationError("path not found");
  }
  if (!containingRoot(realTarget, usableRoots))
    throw new WorkspaceValidationError("path is outside the allowed roots for this server");
  if (!statSync(realTarget).isDirectory())
    throw new WorkspaceValidationError("path is not a directory");
  return listSubdirs(realTarget, usableRoots);
}
