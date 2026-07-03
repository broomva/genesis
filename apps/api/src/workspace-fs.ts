// Read-only workspace filesystem browser (BRO-1666, Slice 1). Two pure, host-local
// operations — LIST a directory + READ a file — under a workspace's server-only
// `rootPath`, path-sandboxed exactly like BRO-1663's `resolvePathAdd`:
//
//   • the client only ever sends a RELATIVE path; an absolute path / `..` traversal
//     is rejected LEXICALLY before touching the filesystem;
//   • the resolved target is then `realpathSync`'d and RE-checked under the root's
//     own realpath, so a symlink pointing OUT of the root (lexically-inside, really-
//     outside) can't escape the sandbox (the HARD, not lexical, boundary);
//   • only RELATIVE paths + file contents ever leave here — the absolute rootPath
//     NEVER crosses back to the caller (it stays an engine-internal detail, mirroring
//     Supervisor.listWorkspaces omitting rootPath from its public DTO).
//
// Node `fs` (not host.exec) is used deliberately: the engine runs the repo on THIS
// box as a LocalHost (the VPS deploy is LocalHost-only), so a direct fs read is the
// simplest correct implementation and keeps the sandbox unit-testable in isolation —
// exactly like workspace-provision.ts. PORTABILITY NOTE: a future VpsHost/microVM
// deployment (repo on a remote/sandbox box) would need a host.exec-based listing +
// host.readFile; that is a Slice-1-follow-up, not required for the current deploy.

import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

/** A rejected client request whose message is SAFE to echo (it never contains an
 *  absolute server path). `status` maps to the HTTP code the route returns: 400 for
 *  a bad/unsafe input, 404 for a missing path, 500 for an unavailable workspace root
 *  (the directory vanished out-of-band). */
export class WorkspaceFsError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 500 = 400,
  ) {
    super(message);
    this.name = "WorkspaceFsError";
  }
}

/** Hard ceiling on a single file read (256 KB) — a huge file is read only up to the
 *  cap (never loaded whole) and flagged `truncated`, so a multi-GB log can't pin the
 *  event loop or blow the response. */
export const MAX_FILE_BYTES = 256 * 1024;

export interface DirEntry {
  /** The entry's own name (a single path segment — never a path). */
  name: string;
  type: "dir" | "file";
  /** Byte size, files only (omitted for dirs + for symlinked targets, whose size we
   *  don't surface). */
  size?: number;
}

export interface FileContent {
  /** The canonical relative path of the file within the workspace root. */
  path: string;
  /** UTF-8 contents (empty when `binary`), capped at {@link MAX_FILE_BYTES}. */
  content: string;
  /** True when the file is larger than the cap (content is the leading slice). */
  truncated: boolean;
  /** True when a NUL byte was seen in the read slice → treated as binary (content ""). */
  binary: boolean;
  /** The file's full byte size on disk. */
  size: number;
}

/** Resolve a client RELATIVE path under `rootPath` into an absolute, symlink-safe
 *  target that provably stays inside the workspace root. Throws {@link WorkspaceFsError}
 *  (safe message) on any escape. Returns the resolved absolute path, its canonical
 *  relative path, and the root's realpath (so callers can re-use the boundary). */
export function resolveInRoot(
  rootPath: string,
  relPath: unknown,
): { abs: string; rel: string; realRoot: string } {
  // The base is the REAL root (symlinks resolved) so the boundary is a HARD sandbox,
  // not a lexical one — a symlinked workspace root still bounds correctly.
  let realRoot: string;
  try {
    realRoot = realpathSync(rootPath);
  } catch {
    throw new WorkspaceFsError("workspace root is unavailable", 500);
  }

  // Default (no/empty path) → the root itself.
  const raw = relPath === undefined || relPath === null ? "" : relPath;
  if (typeof raw !== "string") throw new WorkspaceFsError("path must be a string", 400);
  if (raw.includes("\0")) throw new WorkspaceFsError("invalid path", 400);
  // An ABSOLUTE path would make resolve() ignore the root entirely (→ escape); force
  // relative. (`resolve(root, "/etc")` === "/etc" — this is the load-bearing reject.)
  if (raw.startsWith("/"))
    throw new WorkspaceFsError("path must be relative to the workspace root", 400);

  // Lexical resolve normalizes `..`/`.`; the lexical boundary check catches `../`
  // traversal BEFORE any filesystem access.
  const lexical = resolve(realRoot, raw);
  if (lexical !== realRoot && !lexical.startsWith(realRoot + sep)) {
    throw new WorkspaceFsError("path escapes the workspace root", 400);
  }
  // Resolve symlinks and RE-check: a symlink inside the root pointing OUTSIDE would be
  // lexically-inside but really-outside (mirrors resolvePathAdd's HARD boundary).
  let abs: string;
  try {
    abs = realpathSync(lexical);
  } catch {
    throw new WorkspaceFsError("not found", 404);
  }
  if (abs !== realRoot && !abs.startsWith(realRoot + sep)) {
    throw new WorkspaceFsError("path escapes the workspace root", 400);
  }
  const rel = abs === realRoot ? "" : abs.slice(realRoot.length + 1);
  return { abs, rel, realRoot };
}

/** List the directory at `relPath` (default: the root). Dirs first (alpha), then
 *  files (alpha). Symlinks are followed for classification but only surfaced when
 *  they stay INSIDE the root (an out-of-root link is hidden, and its target size is
 *  never leaked). Throws {@link WorkspaceFsError} on an escape / a non-directory. */
export function listWorkspaceDir(
  rootPath: string,
  relPath: unknown,
): { path: string; entries: DirEntry[] } {
  const { abs, rel, realRoot } = resolveInRoot(rootPath, relPath);
  if (!statSync(abs).isDirectory()) throw new WorkspaceFsError("not a directory", 400);

  const entries: DirEntry[] = [];
  for (const d of readdirSync(abs, { withFileTypes: true })) {
    if (d.isDirectory()) {
      entries.push({ name: d.name, type: "dir" });
    } else if (d.isFile()) {
      let size: number | undefined;
      try {
        size = statSync(resolve(abs, d.name)).size;
      } catch {
        size = undefined; // racing unlink / perms → list it without a size
      }
      entries.push(
        size !== undefined ? { name: d.name, type: "file", size } : { name: d.name, type: "file" },
      );
    } else if (d.isSymbolicLink()) {
      // Follow the link, but keep the sandbox: only surface it when the target stays
      // in-root, and never expose an external target's size (defense-in-depth — the
      // read path re-validates anyway, but hiding out-of-root links avoids the tease).
      try {
        const target = realpathSync(resolve(abs, d.name));
        if (target !== realRoot && !target.startsWith(realRoot + sep)) continue;
        const s = statSync(target);
        if (s.isDirectory()) entries.push({ name: d.name, type: "dir" });
        else if (s.isFile()) entries.push({ name: d.name, type: "file" });
      } catch {
        // broken / dangling link → skip
      }
    }
    // sockets / fifos / devices → skipped (nothing to browse)
  }
  entries.sort((a, b) =>
    a.type !== b.type
      ? a.type === "dir"
        ? -1
        : 1
      : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  return { path: rel, entries };
}

/** Read the file at `relPath`, capped at {@link MAX_FILE_BYTES}. A file with a NUL
 *  byte in the read slice is reported `binary` (content ""); a file over the cap is
 *  reported `truncated` (content is the leading slice). Throws {@link WorkspaceFsError}
 *  on an escape / a directory / a non-regular file. */
export function readWorkspaceFile(rootPath: string, relPath: unknown): FileContent {
  const { abs, rel } = resolveInRoot(rootPath, relPath);
  const st = statSync(abs);
  if (st.isDirectory()) throw new WorkspaceFsError("path is a directory", 400);
  if (!st.isFile()) throw new WorkspaceFsError("not a regular file", 400);

  const size = st.size;
  // Bounded read — never load more than the cap, so a giant file can't blow memory.
  const buf = Buffer.alloc(Math.min(size, MAX_FILE_BYTES));
  const fd = openSync(abs, "r");
  let bytesRead: number;
  try {
    bytesRead = buf.length === 0 ? 0 : readSync(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync(fd);
  }
  const slice = buf.subarray(0, bytesRead);
  const binary = slice.includes(0);
  return {
    path: rel,
    content: binary ? "" : slice.toString("utf8"),
    truncated: size > MAX_FILE_BYTES,
    binary,
    size,
  };
}
