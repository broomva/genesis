// Read-only workspace git status + diff (BRO-1666, Slice 2). Two host-local
// operations over a workspace's server-only `rootPath`: STATUS (what changed) +
// DIFF (a single file's changes). Both run `git` read-only via `execFile` (the same
// direct-git pattern workspace-provision.ts already uses for clone) with:
//
//   • a fixed argv — NO user string ever becomes a git OPTION. The one client input
//     (the diff file path) is validated (lexical, no `..`/absolute/NUL) and passed
//     ONLY as a pathspec AFTER `--`, so it can't be read as a flag; git itself also
//     confines a pathspec to the work tree, so a symlink pathspec can't escape.
//   • bounded output (`maxBuffer` + a 256 KB response cap → `truncated`) and a
//     timeout, so a huge diff / a hung git can't pin the single-threaded engine.
//   • only RELATIVE paths + diff text ever leave — the absolute `rootPath` never does.
//
// PORTABILITY (same as Slice 1's workspace-fs.ts): the engine runs the repo on THIS
// box as a LocalHost, so direct `execFile` is correct + unit-testable. A future
// VpsHost/microVM deploy would route these through `host.exec(["git",…])`.

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { devNull } from "node:os";
import { isAbsolute, normalize } from "node:path";
import { promisify } from "node:util";
import { WorkspaceFsError } from "./workspace-fs";

const execFileAsync = promisify(execFile);

/** Hard ceiling on a single git invocation (10s) — a hung `git` (a lock, a pager
 *  prompt) is killed rather than pinning a request. */
const GIT_TIMEOUT_MS = 10_000;
/** Hard ceiling on git stdout (8 MB) — execFile rejects past this, so a pathological
 *  status/diff can't balloon memory. The response is further capped below. */
const GIT_MAXBUFFER = 8 * 1024 * 1024;
/** Response cap on a diff body (256 KB); a larger diff is truncated + flagged. */
export const MAX_DIFF_BYTES = 256 * 1024;
/** Max files returned in a status (P20 F1 parity) — bounds the response + the client
 *  tree for a repo with a huge working set. */
export const MAX_STATUS_FILES = 2000;

export interface GitFile {
  /** Repo-relative path. */
  path: string;
  /** Porcelain staged-column status (` `/`M`/`A`/`D`/`R`/`C`/`?`/`U`). */
  x: string;
  /** Porcelain unstaged-column status. */
  y: string;
  /** True when the file is untracked (`??`) — displayed as "U" per the screenshot. */
  untracked: boolean;
  /** Lines added vs HEAD (null = binary / unknown; absent for untracked). */
  added: number | null;
  /** Lines deleted vs HEAD (null = binary / unknown). */
  deleted: number | null;
  /** The pre-rename path, when this entry is a rename/copy. */
  orig?: string;
}

export interface GitStatus {
  /** False when the workspace root is not a git repository (the UI degrades). */
  isGitRepo: boolean;
  /** Current branch (undefined when detached / not a repo). */
  branch?: string;
  /** Upstream ref (e.g. `origin/main`) when the branch tracks one. */
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFile[];
  /** True when more than {@link MAX_STATUS_FILES} changed (files is the first N). */
  truncated: boolean;
}

export interface GitDiff {
  path: string;
  /** Unified diff text (empty when `binary`), capped at {@link MAX_DIFF_BYTES}. */
  diff: string;
  truncated: boolean;
  binary: boolean;
}

/** Read-only, HERMETIC git env (P20 Slice 2 HIGH-1 + LOW-1). Mirrors the clone path's
 *  hermeticGitEnv posture — `git diff` is exactly the command that honors config-driven
 *  code-execution channels (`diff.external`, `[diff]textconv`, `GIT_EXTERNAL_DIFF`), so
 *  strip every ambient git-config injection channel + pin global/system config to the
 *  null device. `GIT_LITERAL_PATHSPECS=1` neutralizes ALL pathspec magic (`:/`, `:(top)`,
 *  `:(glob)`, `:(attr)…`) so a `--`-separated client path can only ever be a literal
 *  filename, never a repo-root-anchored escape. Never prompt; don't take an index lock. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_CONFIG")) continue; // COUNT / KEY_* / VALUE_* / GLOBAL / SYSTEM / …
    if (
      k === "GIT_PROXY_COMMAND" ||
      k === "GIT_ASKPASS" ||
      k === "GIT_SSH_COMMAND" ||
      k === "GIT_EXTERNAL_DIFF" ||
      k === "GIT_PAGER"
    )
      continue;
    env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = "0"; // never block on an auth prompt
  env.GIT_OPTIONAL_LOCKS = "0"; // read-only: don't take the index lock
  env.GIT_LITERAL_PATHSPECS = "1"; // kill pathspec magic — a path is only ever a literal
  env.GIT_CONFIG_NOSYSTEM = "1"; // ignore /etc/gitconfig
  env.GIT_CONFIG_GLOBAL = devNull; // ignore ~/.gitconfig (diff.external / textconv)
  env.GIT_CONFIG_SYSTEM = devNull;
  return env;
}

/** Common execFile options for a read-only git call. `killSignal: SIGKILL` (P20 LOW-2,
 *  matching the clone path) so a git that ignores SIGTERM on timeout is still reaped. */
function gitOpts(rootPath: string) {
  return {
    cwd: rootPath,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAXBUFFER,
    killSignal: "SIGKILL" as const,
    env: gitEnv(),
  };
}

/** True only when `rootPath` is the git repository ROOT (not a subdirectory of a larger
 *  repo). The load-bearing confinement check (P20 HIGH-1): without it, git run in a
 *  SUBDIR workspace resolves the ENCLOSING repo, so status/diff would leak files ABOVE
 *  the workspace root — defeating the Slice-1 rootPath sandbox. `--show-toplevel` returns
 *  a realpath'd absolute, and a stored rootPath may be non-realpath'd (resolvePick), so
 *  compare realpaths on both sides. Any failure (not a repo / vanished) → false. */
async function isRepoRoot(rootPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      gitOpts(rootPath),
    );
    return realpathSync(stdout.trim()) === realpathSync(rootPath);
  } catch {
    return false; // not a git repository, or rootPath is gone
  }
}

/** A non-zero git exit carries a NUMERIC `code` + `stderr`; a spawn failure (git
 *  missing) carries a STRING `code`. This is a "not a git repository" exit. */
function isNotARepo(e: unknown): boolean {
  const err = e as { code?: unknown; stderr?: unknown };
  return (
    typeof err?.code === "number" &&
    typeof err?.stderr === "string" &&
    /not a git repository/i.test(err.stderr)
  );
}

/** Validate a client diff pathspec WITHOUT requiring it to exist (a deleted file has
 *  no realpath). Lexical only — reject absolute / `..`-escape / NUL — which together
 *  with the `--` separator + git's own work-tree confinement keeps the pathspec safe.
 *  Returns the normalized repo-relative path. */
function sanitizePathspec(relPath: unknown): string {
  if (typeof relPath !== "string" || relPath.length === 0)
    throw new WorkspaceFsError("a file path is required", 400);
  if (relPath.includes("\0")) throw new WorkspaceFsError("invalid path", 400);
  if (relPath.startsWith("/") || isAbsolute(relPath))
    throw new WorkspaceFsError("path must be relative to the workspace root", 400);
  const norm = normalize(relPath);
  if (norm === ".." || norm.startsWith("../") || norm.startsWith(`..${"\\"}`) || isAbsolute(norm))
    throw new WorkspaceFsError("path escapes the workspace root", 400);
  return norm;
}

/** Parse a porcelain `--branch` header (`## main...origin/main [ahead 1, behind 2]`). */
function parseBranchHeader(header: string): {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
} {
  let h = header.replace(/^## /, "");
  let ahead = 0;
  let behind = 0;
  let upstream: string | undefined;
  let branch: string | undefined;
  const ab = h.match(/\s\[(.*)\]$/);
  const bracket = ab?.[1];
  if (ab && bracket !== undefined) {
    const a = bracket.match(/ahead (\d+)/);
    const b = bracket.match(/behind (\d+)/);
    if (a?.[1]) ahead = Number(a[1]);
    if (b?.[1]) behind = Number(b[1]);
    h = h.slice(0, ab.index).trim();
  }
  if (h.startsWith("No commits yet on ")) {
    branch = h.slice("No commits yet on ".length).trim();
  } else if (h.includes("...")) {
    const idx = h.indexOf("...");
    branch = h.slice(0, idx).trim();
    upstream = h.slice(idx + 3).trim() || undefined;
  } else if (h === "HEAD (no branch)") {
    branch = undefined; // detached
  } else {
    branch = h.trim();
  }
  return { branch, upstream, ahead, behind };
}

/** `git diff --numstat HEAD` → path → {added, deleted} (best-effort; renames skipped,
 *  binary = null). Empty when there is no HEAD yet (a repo with no commits). */
async function numstat(
  rootPath: string,
): Promise<Map<string, { added: number | null; deleted: number | null }>> {
  const m = new Map<string, { added: number | null; deleted: number | null }>();
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--numstat", "HEAD", "--"],
      gitOpts(rootPath),
    );
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const [a, d, ...rest] = line.split("\t");
      const path = rest.join("\t");
      if (!path || a === undefined || d === undefined || path.includes(" => ")) continue; // skip renames
      m.set(path, { added: a === "-" ? null : Number(a), deleted: d === "-" ? null : Number(d) });
    }
  } catch {
    // no HEAD (empty repo) / not a repo → no counts (status still lists the files)
  }
  return m;
}

/** The working-tree change set for a workspace: branch + ahead/behind + per-file
 *  status (with +/- counts vs HEAD). Read-only. Returns `{isGitRepo:false}` for a
 *  non-repo workspace rather than throwing (the UI degrades gracefully). */
export async function gitStatus(rootPath: string): Promise<GitStatus> {
  // Confinement guard (P20 HIGH-1): only a TRUE repo-root workspace is browsable — a
  // subdir workspace would otherwise resolve the enclosing repo and leak files above
  // the root. A non-repo (or subdir) → the graceful non-repo shape, never a leak.
  if (!(await isRepoRoot(rootPath)))
    return { isGitRepo: false, ahead: 0, behind: 0, files: [], truncated: false };

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--branch", "-z", "-uall"],
      gitOpts(rootPath),
    ));
  } catch (e) {
    if (isNotARepo(e))
      return { isGitRepo: false, ahead: 0, behind: 0, files: [], truncated: false };
    throw new WorkspaceFsError("could not read git status", 500);
  }

  const parts = stdout.split("\0");
  let branch: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  const files: GitFile[] = [];
  let i = 0;
  const head = parts[0];
  if (head?.startsWith("## ")) {
    ({ branch, upstream, ahead, behind } = parseBranchHeader(head));
    i = 1;
  }
  for (; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue; // trailing empty field after the final NUL
    const x = entry[0] ?? " ";
    const y = entry[1] ?? " ";
    const path = entry.slice(3); // skip "XY "
    // A rename/copy carries the ORIGINAL path as the NEXT NUL-terminated field.
    const orig = x === "R" || x === "C" ? parts[++i] : undefined;
    files.push({
      path,
      x,
      y,
      untracked: x === "?" && y === "?",
      added: null,
      deleted: null,
      ...(orig ? { orig } : {}),
    });
  }

  // Fold in +/- counts (tracked changes only; untracked have none).
  const counts = await numstat(rootPath);
  for (const f of files) {
    const c = counts.get(f.path);
    if (c) {
      f.added = c.added;
      f.deleted = c.deleted;
    }
  }

  const truncated = files.length > MAX_STATUS_FILES;
  return {
    isGitRepo: true,
    branch,
    upstream,
    ahead,
    behind,
    files: files.slice(0, MAX_STATUS_FILES),
    truncated,
  };
}

/** The unified diff for ONE file (working tree vs index, or `--cached` for staged).
 *  The path is sanitized + passed as a pathspec after `--`. Binary diffs are flagged
 *  (empty text); the body is capped at {@link MAX_DIFF_BYTES}. Throws
 *  {@link WorkspaceFsError} on a bad path / a non-repo. */
export async function gitDiff(
  rootPath: string,
  relPath: unknown,
  opts: { cached?: boolean } = {},
): Promise<GitDiff> {
  const rel = sanitizePathspec(relPath);
  // Same confinement guard as gitStatus (P20 HIGH-1) — refuse a subdir workspace so a
  // diff can't reach the enclosing repo (belt-and-suspenders with GIT_LITERAL_PATHSPECS).
  if (!(await isRepoRoot(rootPath))) throw new WorkspaceFsError("not a git repository", 400);
  const args = ["diff", "--no-color"];
  if (opts.cached) args.push("--cached");
  args.push("--", rel);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", args, gitOpts(rootPath)));
  } catch (e) {
    if (isNotARepo(e)) throw new WorkspaceFsError("not a git repository", 400);
    throw new WorkspaceFsError("could not compute diff", 500);
  }
  const binary = /^Binary files .* differ$/m.test(stdout) || stdout.includes("GIT binary patch");
  const truncated = Buffer.byteLength(stdout) > MAX_DIFF_BYTES;
  return {
    path: rel,
    diff: binary ? "" : truncated ? stdout.slice(0, MAX_DIFF_BYTES) : stdout,
    truncated,
    binary,
  };
}
