"use client";

import { ArrowUp, Check, Folder, FolderGit2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { type AddWorkspaceResult, type BrowseResult, browseForAdd } from "@/lib/workspaces";

/** Filesystem navigator for the add-by-path picker (BRO-1673). Browse to a folder under
 *  the server's add-roots and register it — no typing an absolute path. Owner-only: the
 *  BFF gates /api/workspaces/browse to the owner (browsing surfaces absolute paths), and
 *  the engine hard-sandboxes every path to the add-roots. Feeds the existing
 *  `onAddByPath` on "Add this folder". */
export function FolderPicker({
  onAddByPath,
  onAdded,
}: {
  /** Register the browsed folder by absolute path (BRO-1663) — the same handler the
   *  text input uses. */
  onAddByPath: (path: string) => Promise<AddWorkspaceResult>;
  /** Called after a successful add so the parent can refresh + collapse the picker. */
  onAdded: () => void;
}) {
  const [level, setLevel] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic navigation generation: a slow browse must not clobber a newer one.
  const seqRef = useRef(0);

  const navigate = useCallback(async (path?: string, signal?: AbortSignal) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    const out = await browseForAdd(path, signal);
    if (signal?.aborted || seq !== seqRef.current) return;
    setLoading(false);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    setLevel(out.result);
  }, []);

  // Start at the server's initial level when the picker opens.
  useEffect(() => {
    const ctrl = new AbortController();
    navigate(undefined, ctrl.signal);
    return () => ctrl.abort();
  }, [navigate]);

  const doAdd = useCallback(async () => {
    const path = level?.path;
    if (!path || adding) return;
    setAdding(true);
    setError(null);
    const res = await onAddByPath(path);
    setAdding(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onAdded();
  }, [level, adding, onAddByPath, onAdded]);

  const current = level?.path ?? "Select a location";
  const canGoUp = !!level?.parent;

  return (
    <div className="border-border/60 bg-muted/20 space-y-2 rounded-lg border p-2">
      {/* Current location + up-nav */}
      <div className="flex items-center gap-1.5">
        <Button
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground shrink-0"
          aria-label="Up one folder"
          disabled={!canGoUp || loading}
          onClick={() => canGoUp && navigate(level?.parent ?? undefined)}
        >
          <ArrowUp className="size-3.5" />
        </Button>
        <span
          className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs"
          title={current}
          dir="rtl" // keep the tail (the folder you're in) visible when the path is long
        >
          <bdi>{current}</bdi>
        </span>
      </div>

      {/* Subdirectory list */}
      <div className="max-h-52 min-h-[3rem] overflow-y-auto">
        {loading ? (
          <div className="text-muted-foreground flex items-center gap-2 px-2 py-3 text-xs">
            <Spinner className="size-3.5" /> Loading…
          </div>
        ) : level && level.entries.length > 0 ? (
          <div className="space-y-0.5">
            {level.entries.map((e) => (
              <button
                key={e.path}
                type="button"
                onClick={() => navigate(e.path)}
                className="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors"
              >
                {e.isGitRepo ? (
                  <FolderGit2 className="text-muted-foreground size-3.5 shrink-0" />
                ) : (
                  <Folder className="text-muted-foreground size-3.5 shrink-0" />
                )}
                <span className="text-foreground min-w-0 flex-1 truncate text-sm">{e.name}</span>
                {e.isGitRepo ? (
                  <Badge variant="secondary" className="shrink-0 text-[0.65rem]">
                    git
                  </Badge>
                ) : null}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-muted-foreground px-2 py-3 text-xs">No subfolders here.</div>
        )}
      </div>

      {level?.truncated ? (
        <p className="text-muted-foreground px-2 text-[0.65rem]">
          Showing the first {level.entries.length} folders. Some are hidden.
        </p>
      ) : null}

      {/* Add the current folder */}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="w-full"
        disabled={!level?.registerable || adding || loading}
        onClick={doAdd}
      >
        {adding ? (
          <Spinner className="size-3.5" />
        ) : (
          <>
            <Check className="size-3.5" /> Add this folder
          </>
        )}
      </Button>

      {error ? <p className="text-destructive px-1 text-xs leading-snug">{error}</p> : null}
    </div>
  );
}
