"use client";

import {
  ArrowLeft,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderGit2,
  Loader2,
  X,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { type DirListing, type FileContent, fetchDir, fetchFile } from "@/lib/files";
import { cn } from "@/lib/utils";

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

/** The read-only workspace filesystem browser (BRO-1666 Slice 1): a right-anchored
 *  slide-over (radix Dialog — focus-trap + Escape + scroll-lock), cloning the
 *  SettingsSheet structure. Tab strip mirrors the reference screenshot (Repo Files
 *  active; Changes/Checks are stubs for Slices 2–3). Browses the ACTIVE thread's
 *  bound workspace root, lazily (a dir's children load on expand). */
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
  // Root listing — (re)fetched when the sheet opens or the workspace changes.
  const root = useDir(workspaceId, "", open);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  // Reset the open file + collapse the tree whenever the workspace changes or the
  // sheet re-opens (the tree remounts via key={workspaceId}; this clears the viewer).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on open/workspace change
  useEffect(() => {
    setOpenFilePath(null);
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

          {/* Tab strip (screenshot parity) — Repo Files is Slice 1; Changes/Checks
              arrive in Slices 2–3, shown disabled so the roadmap is legible. */}
          <div className="border-border border-b px-4 py-2.5">
            <SegmentedControl type="single" value="files" aria-label="Workspace section">
              <SegmentedControlItem value="files">Repo Files</SegmentedControlItem>
              <SegmentedControlItem value="changes" disabled title="Coming soon">
                Changes
              </SegmentedControlItem>
              <SegmentedControlItem value="checks" disabled title="Coming soon">
                Checks
              </SegmentedControlItem>
            </SegmentedControl>
          </div>

          {openFilePath ? (
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
