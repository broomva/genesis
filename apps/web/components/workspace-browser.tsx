"use client";

import {
  ArrowLeft,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderGit2,
  GitBranch,
  GitCommitVertical,
  Loader2,
  X,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { type DirListing, type FileContent, fetchDir, fetchFile } from "@/lib/files";
import {
  type GitFileEntry,
  type GitStatusData,
  commitAndPush,
  fetchGitDiff,
  fetchGitStatus,
  fileIsStagedOnly,
  statusBadge,
  validateCommitMessage,
} from "@/lib/git";
import { cn } from "@/lib/utils";

type Tab = "files" | "changes";

/** Join a relative dir path with a child name (both relative to the workspace root). */
function childPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Human-readable byte size (files only). */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type DirState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; listing: DirListing };

/** Fetch a directory listing when `enabled`. Aborts on unmount / dep change. */
function useDir(workspaceId: string, path: string, enabled: boolean): DirState | null {
  const [state, setState] = useState<DirState | null>(null);
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    const ctrl = new AbortController();
    setState({ status: "loading" });
    fetchDir(workspaceId, path, ctrl.signal)
      .then((listing) => {
        if (!ctrl.signal.aborted) setState({ status: "ready", listing });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setState({ status: "error", error: e instanceof Error ? e.message : "failed to load" });
      });
    return () => ctrl.abort();
  }, [workspaceId, path, enabled]);
  return state;
}

const ROW =
  "flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-sm transition-colors hover:bg-[var(--bv-canvas-soft-2)] [@media(pointer:coarse)]:py-2";

/** A file leaf — tap to open it in the viewer. */
function FileRow({
  entry,
  path,
  depth,
  onOpen,
}: {
  entry: { name: string; size?: number };
  path: string;
  depth: number;
  onOpen: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className={ROW}
      style={{ paddingLeft: `${depth * 14 + 8}px` }}
      onClick={() => onOpen(path)}
      data-testid="ws-tree-row"
      data-path={path}
    >
      <FileIcon className="text-muted-foreground size-4 shrink-0" />
      <span className="truncate">{entry.name}</span>
      {typeof entry.size === "number" ? (
        <span className="text-muted-foreground ml-auto shrink-0 pl-2 text-[0.7rem] tabular-nums">
          {formatSize(entry.size)}
        </span>
      ) : null}
    </button>
  );
}

/** A directory node — lazily fetches its children the first time it's expanded. */
function DirRow({
  workspaceId,
  entry,
  path,
  depth,
  onOpenFile,
}: {
  workspaceId: string;
  entry: { name: string };
  path: string;
  depth: number;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const dir = useDir(workspaceId, path, open);
  return (
    <>
      <button
        type="button"
        className={ROW}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="ws-tree-row"
        data-path={path}
      >
        <ChevronRight
          className={cn(
            "text-muted-foreground size-3.5 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        <Folder className="size-4 shrink-0 text-[var(--bv-blue-text)]" />
        <span className="truncate">{entry.name}</span>
      </button>
      {open ? (
        <div>
          {dir?.status === "loading" ? (
            <p
              className="text-muted-foreground flex items-center gap-1.5 py-1 text-xs"
              style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
            >
              <Loader2 className="size-3 animate-spin" /> Loading…
            </p>
          ) : null}
          {dir?.status === "error" ? (
            <p
              className="text-[var(--bv-danger)] py-1 text-xs"
              style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
            >
              {dir.error}
            </p>
          ) : null}
          {dir?.status === "ready" ? (
            dir.listing.entries.length === 0 ? (
              <p
                className="text-muted-foreground py-1 text-xs italic"
                style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
              >
                empty
              </p>
            ) : (
              <FsNodes
                workspaceId={workspaceId}
                listing={dir.listing}
                depth={depth + 1}
                onOpenFile={onOpenFile}
              />
            )
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** Render a listing's entries as rows (dirs, then files — server already sorts). */
function FsNodes({
  workspaceId,
  listing,
  depth,
  onOpenFile,
}: {
  workspaceId: string;
  listing: DirListing;
  depth: number;
  onOpenFile: (path: string) => void;
}) {
  return (
    <>
      {listing.entries.map((entry) => {
        const path = childPath(listing.path, entry.name);
        return entry.type === "dir" ? (
          <DirRow
            key={path}
            workspaceId={workspaceId}
            entry={entry}
            path={path}
            depth={depth}
            onOpenFile={onOpenFile}
          />
        ) : (
          <FileRow key={path} entry={entry} path={path} depth={depth} onOpen={onOpenFile} />
        );
      })}
      {listing.truncated ? (
        <p
          className="text-muted-foreground py-1 text-xs italic"
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          …folder truncated (showing {listing.entries.length})
        </p>
      ) : null}
    </>
  );
}

/** The open-file viewer — a plain, robust monospace code view (no highlighter
 *  dependency), with binary/truncated/empty notices. */
function FileViewer({
  workspaceId,
  path,
  onBack,
}: {
  workspaceId: string;
  path: string;
  onBack: () => void;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; error: string }
    | { status: "ready"; file: FileContent }
  >({ status: "loading" });
  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: "loading" });
    fetchFile(workspaceId, path, ctrl.signal)
      .then((file) => {
        if (!ctrl.signal.aborted) setState({ status: "ready", file });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setState({ status: "error", error: e instanceof Error ? e.message : "failed to load" });
      });
    return () => ctrl.abort();
  }, [workspaceId, path]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ws-file-view">
      <div className="border-border flex items-center gap-2 border-b px-2 py-2">
        <Button size="icon-sm" variant="ghost" onClick={onBack} aria-label="Back to files">
          <ArrowLeft className="size-4" />
        </Button>
        <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs" title={path}>
          {path}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {state.status === "loading" ? (
          <p className="text-muted-foreground flex items-center gap-1.5 p-4 text-xs">
            <Loader2 className="size-3 animate-spin" /> Loading…
          </p>
        ) : null}
        {state.status === "error" ? (
          <p className="text-[var(--bv-danger)] p-4 text-sm">{state.error}</p>
        ) : null}
        {state.status === "ready" ? (
          state.file.binary ? (
            <p className="text-muted-foreground p-4 text-sm italic">
              Binary file ({formatSize(state.file.size)}) — not shown.
            </p>
          ) : state.file.content.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm italic">Empty file.</p>
          ) : (
            <>
              <pre className="text-foreground overflow-x-auto p-4 font-mono text-xs leading-relaxed whitespace-pre">
                {state.file.content}
              </pre>
              {state.file.truncated ? (
                <p className="text-muted-foreground border-border border-t px-4 py-2 text-xs italic">
                  Truncated — showing the first {formatSize(256 * 1024)} of{" "}
                  {formatSize(state.file.size)}.
                </p>
              ) : null}
            </>
          )
        ) : null}
      </div>
    </div>
  );
}

/** Tailwind color per porcelain status badge. */
function badgeClass(badge: string): string {
  switch (badge) {
    case "M":
      return "text-[var(--bv-amber-text,#b8860b)] border-[var(--bv-amber-text,#b8860b)]/40";
    case "A":
      return "text-[var(--bv-green-text,#2e7d32)] border-[var(--bv-green-text,#2e7d32)]/40";
    case "D":
      return "text-[var(--bv-danger)] border-[var(--bv-danger)]/40";
    case "U":
      return "text-muted-foreground border-border";
    default: // R / C / others
      return "text-[var(--bv-blue-text)] border-[var(--bv-blue-text)]/40";
  }
}

/** Per-line class for a unified-diff line (add/remove/hunk/header/context). */
function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-muted-foreground";
  if (line.startsWith("@@")) return "text-[var(--bv-blue-text)] bg-[var(--bv-blue-text)]/8";
  if (line.startsWith("+"))
    return "text-[var(--bv-green-text,#2e7d32)] bg-[var(--bv-green-text,#2e7d32)]/8";
  if (line.startsWith("-")) return "text-[var(--bv-danger)] bg-[var(--bv-danger)]/8";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "text-muted-foreground";
  return "text-foreground";
}

/** The diff viewer for one changed file — colored unified diff, binary/empty notices. */
function DiffViewer({
  workspaceId,
  path,
  cached,
  onBack,
}: {
  workspaceId: string;
  path: string;
  cached: boolean;
  onBack: () => void;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; error: string }
    | { status: "ready"; diff: string; binary: boolean; truncated: boolean }
  >({ status: "loading" });
  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: "loading" });
    fetchGitDiff(workspaceId, path, cached, ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted)
          setState({ status: "ready", diff: d.diff, binary: d.binary, truncated: d.truncated });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setState({ status: "error", error: e instanceof Error ? e.message : "failed to load" });
      });
    return () => ctrl.abort();
  }, [workspaceId, path, cached]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ws-diff-view">
      <div className="border-border flex items-center gap-2 border-b px-2 py-2">
        <Button size="icon-sm" variant="ghost" onClick={onBack} aria-label="Back to changes">
          <ArrowLeft className="size-4" />
        </Button>
        <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs" title={path}>
          {path}
        </span>
        {cached ? (
          <span className="text-muted-foreground border-border shrink-0 rounded border px-1.5 py-0.5 text-[0.65rem]">
            staged
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-2 font-mono text-xs leading-relaxed">
        {state.status === "loading" ? (
          <p className="text-muted-foreground flex items-center gap-1.5 p-4">
            <Loader2 className="size-3 animate-spin" /> Loading…
          </p>
        ) : null}
        {state.status === "error" ? (
          <p className="text-[var(--bv-danger)] p-4 text-sm">{state.error}</p>
        ) : null}
        {state.status === "ready" ? (
          state.binary ? (
            <p className="text-muted-foreground p-4 text-sm italic">
              Binary file — diff not shown.
            </p>
          ) : state.diff.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm italic">
              No diff to show — the file may be untracked (open it in Repo Files) or unchanged.
            </p>
          ) : (
            <>
              {state.diff.split("\n").map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are stable + ordered
                <div key={i} className={cn("whitespace-pre px-4", diffLineClass(line))}>
                  {line || " "}
                </div>
              ))}
              {state.truncated ? (
                <p className="text-muted-foreground border-border mt-2 border-t px-4 py-2 text-xs italic">
                  Diff truncated (large file).
                </p>
              ) : null}
            </>
          )
        ) : null}
      </div>
    </div>
  );
}

/** One changed-file row: a status badge, the path (with rename origin), +/- counts. */
function FileStatusRow({ file, onOpen }: { file: GitFileEntry; onOpen: () => void }) {
  const badge = statusBadge(file);
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-[var(--bv-canvas-soft-2)] [@media(pointer:coarse)]:py-2"
      onClick={onOpen}
      data-testid="ws-change-row"
      data-path={file.path}
    >
      <span
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded border font-mono text-[0.7rem] font-medium",
          badgeClass(badge),
        )}
      >
        {badge}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {file.orig ? <span className="text-muted-foreground">{file.orig} → </span> : null}
        {file.path}
      </span>
      {file.added !== null || file.deleted !== null ? (
        <span className="shrink-0 pl-2 font-mono text-[0.7rem] tabular-nums">
          {file.added !== null ? (
            <span className="text-[var(--bv-green-text,#2e7d32)]">+{file.added}</span>
          ) : null}{" "}
          {file.deleted !== null ? (
            <span className="text-[var(--bv-danger)]">-{file.deleted}</span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

/** Commit & Push composer (BRO-1666 Slice 3, owner-only) — a message field + a
 *  Commit&Push action. Stages ALL changes, commits, pushes to the upstream; owner-
 *  gated at the BFF (an agent principal gets 403, surfaced here as an error). */
function CommitBox({
  workspaceId,
  hasUntracked,
  onCommitted,
}: {
  workspaceId: string;
  /** True when the change set includes untracked files — they are NOT committed
   *  (commit stages tracked edits only, P20 HIGH-1), so tell the user. */
  hasUntracked: boolean;
  onCommitted: () => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function submit() {
    const invalid = validateCommitMessage(message);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const r = await commitAndPush(workspaceId, message, true);
      const short = r.sha.slice(0, 7);
      setMessage("");
      setNote(
        r.pushed
          ? `Committed + pushed (${short}).`
          : r.pushError
            ? `Committed (${short}) — ${r.pushError}`
            : `Committed (${short}).`,
      );
      onCommitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "commit failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-border mt-2 border-t px-2 pt-3">
      <textarea
        value={message}
        onChange={(e) => {
          setMessage(e.target.value);
          setError(null);
        }}
        placeholder="Commit message…"
        rows={2}
        data-testid="ws-commit-message"
        className="border-border bg-background focus-visible:ring-ring/50 w-full resize-none rounded-md border px-2.5 py-2 text-sm outline-none focus-visible:ring-3"
      />
      {hasUntracked ? (
        <p className="text-muted-foreground mt-1 px-0.5 text-xs">
          New (U) files aren't included — only edits to tracked files are committed.
        </p>
      ) : null}
      {error ? <p className="text-[var(--bv-danger)] mt-1 px-0.5 text-xs">{error}</p> : null}
      {note ? <p className="text-muted-foreground mt-1 px-0.5 text-xs">{note}</p> : null}
      <div className="mt-2 flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={submit}
          disabled={busy || message.trim().length === 0}
          data-testid="ws-commit-submit"
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <GitCommitVertical className="size-3.5" />
          )}
          Commit &amp; Push
        </Button>
      </div>
    </div>
  );
}

/** The Changes tab (BRO-1666 Slice 2/3): git status list + per-file diff (read-only)
 *  + a Commit&Push composer (Slice 3, owner-only). Fetches status when the tab becomes
 *  active (and after a commit); tapping a file opens its diff (staged when the file is
 *  staged-only, else the working-tree diff). */
function ChangesPanel({ workspaceId, active }: { workspaceId: string; active: boolean }) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; error: string }
    | { status: "ready"; data: GitStatusData }
    | null
  >(null);
  const [openDiff, setOpenDiff] = useState<{ path: string; cached: boolean } | null>(null);
  // Bumped after a commit so the status list refetches (files should clear).
  const [reloadKey, setReloadKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a deliberate refetch trigger
  useEffect(() => {
    if (!active || !workspaceId) return;
    const ctrl = new AbortController();
    setState({ status: "loading" });
    fetchGitStatus(workspaceId, ctrl.signal)
      .then((data) => {
        if (!ctrl.signal.aborted) setState({ status: "ready", data });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setState({ status: "error", error: e instanceof Error ? e.message : "failed to load" });
      });
    return () => ctrl.abort();
  }, [workspaceId, active, reloadKey]);
  // Close any open diff when the workspace changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on workspace change
  useEffect(() => {
    setOpenDiff(null);
  }, [workspaceId]);

  if (openDiff) {
    return (
      <DiffViewer
        workspaceId={workspaceId}
        path={openDiff.path}
        cached={openDiff.cached}
        onBack={() => setOpenDiff(null)}
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
      {!workspaceId ? (
        <p className="text-muted-foreground p-4 text-sm">No workspace selected.</p>
      ) : !state || state.status === "loading" ? (
        <p className="text-muted-foreground flex items-center gap-1.5 p-4 text-sm">
          <Loader2 className="size-3.5 animate-spin" /> Loading…
        </p>
      ) : state.status === "error" ? (
        <p className="text-[var(--bv-danger)] p-4 text-sm">{state.error}</p>
      ) : !state.data.isGitRepo ? (
        <p className="text-muted-foreground p-4 text-sm italic">
          This workspace is not a git repository.
        </p>
      ) : (
        <>
          {state.data.branch ? (
            <div className="text-muted-foreground mb-1 flex items-center gap-1.5 px-2 py-1 text-xs">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="text-foreground truncate font-medium">{state.data.branch}</span>
              {state.data.ahead > 0 ? <span title="ahead">↑{state.data.ahead}</span> : null}
              {state.data.behind > 0 ? <span title="behind">↓{state.data.behind}</span> : null}
              {state.data.upstream ? (
                <span className="truncate">· {state.data.upstream}</span>
              ) : null}
            </div>
          ) : null}
          {state.data.files.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm italic">
              No changes — the working tree is clean.
            </p>
          ) : (
            state.data.files.map((f) => (
              <FileStatusRow
                key={f.path}
                file={f}
                onOpen={() => setOpenDiff({ path: f.path, cached: fileIsStagedOnly(f) })}
              />
            ))
          )}
          {state.data.truncated ? (
            <p className="text-muted-foreground px-2 py-1 text-xs italic">
              …too many changes to show all.
            </p>
          ) : null}
          {state.data.files.length > 0 ? (
            <CommitBox
              workspaceId={workspaceId}
              hasUntracked={state.data.files.some((f) => f.untracked)}
              onCommitted={() => setReloadKey((k) => k + 1)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/** The read-only workspace filesystem browser (BRO-1666): a right-anchored slide-over
 *  (radix Dialog — focus-trap + Escape + scroll-lock), cloning the SettingsSheet
 *  structure. Two live tabs — Repo Files (Slice 1, lazy tree) + Changes (Slice 2, git
 *  status + diff); Checks is a stub for Slice 4. Browses the ACTIVE thread's bound
 *  workspace root. */
export function WorkspaceBrowser({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The active thread's bound workspace id (else the selected one). "" → nothing to
   *  browse (the body shows an empty state). */
  workspaceId: string;
  /** Display name for the header subtitle. */
  workspaceName?: string;
}) {
  const [tab, setTab] = useState<Tab>("files");
  // Root listing — (re)fetched when the sheet opens or the workspace changes.
  const root = useDir(workspaceId, "", open);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  // Reset the open file + tab whenever the workspace changes or the sheet re-opens
  // (the tree remounts via key={workspaceId}; this clears the viewer + returns to Files).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on open/workspace change
  useEffect(() => {
    setOpenFilePath(null);
    setTab("files");
  }, [workspaceId, open]);

  const onOpenFile = useCallback((path: string) => setOpenFilePath(path), []);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[oklch(0.14_0.025_270/0.45)] duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          data-slot="workspace-browser"
          data-testid="workspace-browser"
          className={cn(
            "bg-background text-foreground border-border fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l shadow-xl outline-none sm:max-w-lg",
            "duration-200 data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right",
          )}
        >
          <div className="border-border flex items-center justify-between gap-2 border-b px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:pt-3">
            <div className="flex min-w-0 items-center gap-2">
              <FolderGit2 className="size-4 shrink-0 text-[var(--bv-blue-text)]" />
              <div className="min-w-0">
                <DialogPrimitive.Title className="font-heading text-base font-medium leading-tight tracking-tight">
                  Files
                </DialogPrimitive.Title>
                {workspaceName ? (
                  <p className="text-muted-foreground truncate text-xs leading-tight">
                    {workspaceName}
                  </p>
                ) : null}
              </div>
            </div>
            <DialogPrimitive.Close asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Close files">
                <X className="size-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="sr-only">
            Browse the files in this session's workspace.
          </DialogPrimitive.Description>

          {/* Tab strip (screenshot parity) — Repo Files (Slice 1) + Changes (Slice 2)
              are live; Checks is a stub for Slice 4. */}
          <div className="border-border border-b px-4 py-2.5">
            <SegmentedControl
              type="single"
              value={tab}
              onValueChange={(v) => {
                if (v === "files" || v === "changes") setTab(v);
              }}
              aria-label="Workspace section"
            >
              <SegmentedControlItem value="files" data-testid="ws-tab-files">
                Repo Files
              </SegmentedControlItem>
              <SegmentedControlItem value="changes" data-testid="ws-tab-changes">
                Changes
              </SegmentedControlItem>
              <SegmentedControlItem value="checks" disabled title="Coming soon">
                Checks
              </SegmentedControlItem>
            </SegmentedControl>
          </div>

          {tab === "changes" ? (
            <ChangesPanel workspaceId={workspaceId} active={open && tab === "changes"} />
          ) : openFilePath ? (
            <FileViewer
              workspaceId={workspaceId}
              path={openFilePath}
              onBack={() => setOpenFilePath(null)}
            />
          ) : (
            <div
              key={workspaceId}
              className="min-h-0 flex-1 overflow-y-auto px-2 py-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
            >
              {!workspaceId ? (
                <p className="text-muted-foreground p-4 text-sm">No workspace selected.</p>
              ) : root?.status === "loading" ? (
                <p className="text-muted-foreground flex items-center gap-1.5 p-4 text-sm">
                  <Loader2 className="size-3.5 animate-spin" /> Loading…
                </p>
              ) : root?.status === "error" ? (
                <p className="text-[var(--bv-danger)] p-4 text-sm">{root.error}</p>
              ) : root?.status === "ready" ? (
                root.listing.entries.length === 0 ? (
                  <p className="text-muted-foreground p-4 text-sm italic">
                    This workspace is empty.
                  </p>
                ) : (
                  <FsNodes
                    workspaceId={workspaceId}
                    listing={root.listing}
                    depth={0}
                    onOpenFile={onOpenFile}
                  />
                )
              ) : null}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
