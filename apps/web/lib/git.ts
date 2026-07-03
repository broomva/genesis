// Client helpers for the read-only workspace git browser (BRO-1666 Slice 2, the
// Changes tab). Talks to the BFF proxy (/api/workspaces/:id/git/*) — never the
// engine. Normalizers are pure (testable without a fetch) + defensive (a malformed
// file entry is dropped rather than crashing the list).

/** One changed file in a git status. */
export interface GitFileEntry {
  /** Repo-relative path. */
  path: string;
  /** Porcelain staged-column code (` `/`M`/`A`/`D`/`R`/`C`/`?`/`U`). */
  x: string;
  /** Porcelain unstaged-column code. */
  y: string;
  untracked: boolean;
  /** Lines added vs HEAD (null = binary/unknown; absent for untracked). */
  added: number | null;
  /** Lines deleted vs HEAD (null = binary/unknown). */
  deleted: number | null;
  /** Pre-rename path, when this entry is a rename/copy. */
  orig?: string;
}

export interface GitStatusData {
  isGitRepo: boolean;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFileEntry[];
  truncated: boolean;
}

export interface GitDiffData {
  path: string;
  diff: string;
  truncated: boolean;
  binary: boolean;
}

function toNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Coerce an untrusted `/git/status` body into a clean {@link GitStatusData}. */
export function normalizeStatus(data: unknown): GitStatusData {
  const d = (data ?? {}) as Record<string, unknown>;
  const files: GitFileEntry[] = Array.isArray(d.files)
    ? d.files
        .filter((f): f is Record<string, unknown> => typeof (f as GitFileEntry)?.path === "string")
        .map((f) => {
          const orig = typeof f.orig === "string" ? f.orig : undefined;
          return {
            path: f.path as string,
            x: typeof f.x === "string" && f.x.length > 0 ? f.x : " ",
            y: typeof f.y === "string" && f.y.length > 0 ? f.y : " ",
            untracked: f.untracked === true,
            added: toNumberOrNull(f.added),
            deleted: toNumberOrNull(f.deleted),
            ...(orig ? { orig } : {}),
          };
        })
    : [];
  return {
    isGitRepo: d.isGitRepo !== false, // absent/older engine → assume a repo
    branch: typeof d.branch === "string" ? d.branch : undefined,
    upstream: typeof d.upstream === "string" ? d.upstream : undefined,
    ahead: toNumberOrNull(d.ahead) ?? 0,
    behind: toNumberOrNull(d.behind) ?? 0,
    files,
    truncated: d.truncated === true,
  };
}

/** Coerce an untrusted `/git/diff` body into a clean {@link GitDiffData}. */
export function normalizeDiff(data: unknown): GitDiffData {
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    path: typeof d.path === "string" ? d.path : "",
    diff: typeof d.diff === "string" ? d.diff : "",
    truncated: d.truncated === true,
    binary: d.binary === true,
  };
}

/** A short one-letter status badge for a changed file (screenshot convention:
 *  untracked → "U"; else the staged code if staged, else the unstaged code). */
export function statusBadge(f: GitFileEntry): string {
  if (f.untracked) return "U";
  if (f.x !== " " && f.x !== "?") return f.x;
  if (f.y !== " " && f.y !== "?") return f.y;
  return "M";
}

/** Does tapping this file show the STAGED diff? (staged-only files have no unstaged
 *  change, so the working-tree diff would be empty.) */
export function fileIsStagedOnly(f: GitFileEntry): boolean {
  return f.x !== " " && f.x !== "?" && (f.y === " " || f.y === "");
}

/** Fetch the working-tree change set. Rejects with the engine's SAFE message. */
export async function fetchGitStatus(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<GitStatusData> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/status`, {
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof (data as { error?: unknown })?.error === "string"
        ? (data as { error: string }).error
        : "could not read git status",
    );
  }
  return normalizeStatus(data);
}

export interface CommitResultData {
  committed: boolean;
  pushed: boolean;
  sha: string;
  branch?: string;
  /** Set when the commit landed but the push didn't. */
  pushError?: string;
}

/** Max commit-message length (mirrors the server MAX_COMMIT_MSG). */
export const MAX_COMMIT_MSG = 4000;

/** Client-side commit-message validation → an error string, or null when valid.
 *  (The server re-validates; this is for immediate UI feedback.) */
export function validateCommitMessage(message: string): string | null {
  if (!message.trim()) return "Enter a commit message.";
  if (message.length > MAX_COMMIT_MSG) return "Commit message is too long.";
  return null;
}

/** Coerce an untrusted `/git/commit` body into a clean {@link CommitResultData}. */
export function normalizeCommit(data: unknown): CommitResultData {
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    committed: d.committed === true,
    pushed: d.pushed === true,
    sha: typeof d.sha === "string" ? d.sha : "",
    branch: typeof d.branch === "string" ? d.branch : undefined,
    pushError: typeof d.pushError === "string" ? d.pushError : undefined,
  };
}

/** Commit all changes (+ optional push). Owner-only at the BFF (an agent principal
 *  gets 403). Rejects with the engine's SAFE message on a bad request. */
export async function commitAndPush(
  workspaceId: string,
  message: string,
  push: boolean,
): Promise<CommitResultData> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, push }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof (data as { error?: unknown })?.error === "string"
        ? (data as { error: string }).error
        : "commit failed",
    );
  }
  return normalizeCommit(data);
}

/** Fetch one file's diff (`cached` → staged). Rejects with the engine's SAFE message. */
export async function fetchGitDiff(
  workspaceId: string,
  path: string,
  cached: boolean,
  signal?: AbortSignal,
): Promise<GitDiffData> {
  const qs = new URLSearchParams({ path });
  if (cached) qs.set("cached", "1");
  const res = await fetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/git/diff?${qs.toString()}`,
    { signal },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof (data as { error?: unknown })?.error === "string"
        ? (data as { error: string }).error
        : "could not compute diff",
    );
  }
  return normalizeDiff(data);
}
