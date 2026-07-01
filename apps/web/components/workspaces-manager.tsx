"use client";

import { FolderGit2, GitBranch, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  type AddWorkspaceResult,
  type AvailableRepo,
  type Workspace,
  fetchAvailableWorkspaces,
} from "@/lib/workspaces";

/** Manage the workspaces the agent can run in (BRO-1629 slice 3) — the visible
 *  half of the FS-native substrate. Lists the registered workspaces (remove any
 *  but the default) and offers the discoverable repos under the projects root to
 *  add, one tap each. The client only ever handles a directory NAME — the engine
 *  derives + validates the filesystem path (POST /workspaces), so nothing here
 *  can name an arbitrary path.
 *
 *  Self-hides when there's nothing to manage (≤1 workspace and nothing to add) so
 *  single-workspace deploys are unchanged — matching the composer picker's rule. */
export function WorkspacesManager({
  workspaces,
  defaultWorkspaceId,
  onAdd,
  onAddByUrl,
  onRemove,
}: {
  workspaces: Workspace[];
  /** The server default id — protected from removal (the engine rejects it too). */
  defaultWorkspaceId: string;
  /** Register a picked dir; the parent refreshes the workspace list on success. */
  onAdd: (pick: string) => Promise<AddWorkspaceResult>;
  /** Clone + register a public git URL (BRO-1629 slice 5); the parent refreshes the
   *  workspace list on success. The engine validates the URL (https + host allowlist
   *  + no credentials) — nothing is validated here beyond non-empty. */
  onAddByUrl: (gitUrl: string) => Promise<AddWorkspaceResult>;
  /** De-register; the parent refreshes the workspace list on success. */
  onRemove: (id: string) => Promise<boolean>;
}) {
  const [available, setAvailable] = useState<AvailableRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState("");
  const [addingUrl, setAddingUrl] = useState(false);
  // Track in-flight mutations PER id/name (P20 Forge N1): a single-slot busy
  // marker would re-enable an already-clicked row the moment a second row's
  // action starts, opening a double-submit window. Sets keep each row's spinner
  // + disabled state independent.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [addingNames, setAddingNames] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  // Monotonic fetch generation (P20 Forge S2): mount-fetch and the post-mutation
  // refetch both write `available` with no ordering guarantee — a slow first GET
  // could clobber a fresh post-remove result. Only the latest-issued fetch wins.
  const seqRef = useRef(0);

  const refetch = useCallback(async (signal?: AbortSignal) => {
    const seq = ++seqRef.current;
    const repos = await fetchAvailableWorkspaces(signal);
    if (!signal?.aborted && seq === seqRef.current) setAvailable(repos);
  }, []);

  // Fetch the pickable repos when the sheet opens (this component only mounts
  // while the settings sheet is open — Radix Dialog doesn't force-mount).
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    refetch(ctrl.signal).finally(() => {
      if (!ctrl.signal.aborted) setLoading(false);
    });
    return () => ctrl.abort();
  }, [refetch]);

  const doAdd = useCallback(
    async (pick: string) => {
      setError(null);
      setAddingNames((prev) => new Set(prev).add(pick));
      const res = await onAdd(pick);
      setAddingNames((prev) => {
        const next = new Set(prev);
        next.delete(pick);
        return next;
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await refetch(); // the just-added repo drops off the available list
    },
    [onAdd, refetch],
  );

  const doAddByUrl = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const gitUrl = url.trim();
      if (!gitUrl || addingUrl) return;
      setError(null);
      setAddingUrl(true);
      const res = await onAddByUrl(gitUrl);
      setAddingUrl(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setUrl(""); // clear on success; the parent refresh surfaces the new workspace
      await refetch(); // keep the pickable list in sync (the clone may shadow a pick)
    },
    [url, addingUrl, onAddByUrl, refetch],
  );

  const doRemove = useCallback(
    async (id: string) => {
      setError(null);
      setBusyIds((prev) => new Set(prev).add(id));
      const ok = await onRemove(id);
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (!ok) {
        setError("Could not remove this project. It may be in use.");
        return;
      }
      await refetch(); // the de-registered repo returns to the available list
    },
    [onRemove, refetch],
  );

  // Suppress the render entirely while the first fetch is still in flight in the
  // single-workspace case (P20 Forge S1): otherwise the section paints (default
  // row) then vanishes when `available` resolves to [] — a flash on every open.
  // Multi-workspace deploys render immediately (nothing to flash — they stay).
  if (loading && workspaces.length <= 1) return null;
  // Nothing to manage AND nothing to add → stay invisible (single-workspace
  // deploys are unchanged, matching the composer picker's rule).
  if (!loading && workspaces.length <= 1 && available.length === 0) return null;

  return (
    <section className="space-y-3.5">
      <h3 className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wide">
        <FolderGit2 className="size-3.5" />
        Projects
      </h3>

      <div className="space-y-1.5">
        {workspaces.map((w) => {
          const isDefault = w.id === defaultWorkspaceId;
          const removing = busyIds.has(w.id);
          // BRO-1630 RC3: the engine reports a workspace whose directory vanished
          // on disk as available:false. Surface it (a thread bound here errors at
          // run time) instead of pretending it's usable.
          const unavailable = w.available === false;
          return (
            <div
              key={w.id}
              className="border-border/60 bg-muted/30 flex items-center gap-2.5 rounded-lg border px-3 py-2"
            >
              <span
                className={`min-w-0 flex-1 truncate text-sm ${unavailable ? "text-muted-foreground line-through" : "text-foreground"}`}
              >
                {w.name}
              </span>
              {unavailable ? (
                <Badge variant="destructive" className="shrink-0 text-[0.65rem]">
                  unavailable
                </Badge>
              ) : null}
              {w.isGitRepo ? (
                <Badge variant="secondary" className="shrink-0 text-[0.65rem]">
                  git
                </Badge>
              ) : null}
              {isDefault ? (
                <span className="text-muted-foreground shrink-0 text-xs">default</span>
              ) : (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive shrink-0"
                  aria-label={`Remove ${w.name}`}
                  disabled={removing}
                  onClick={() => doRemove(w.id)}
                >
                  {removing ? <Spinner className="size-3.5" /> : <Trash2 className="size-3.5" />}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {available.length > 0 ? (
        <div className="space-y-1.5 pt-1">
          <p className="text-muted-foreground text-xs">Add a project</p>
          {available.map((r) => {
            const adding = addingNames.has(r.name);
            return (
              <button
                key={r.id}
                type="button"
                disabled={adding}
                onClick={() => doAdd(r.name)}
                className="border-border/60 hover:bg-accent hover:border-border flex w-full items-center gap-2.5 rounded-lg border border-dashed px-3 py-2 text-left transition-colors disabled:opacity-60"
              >
                {adding ? (
                  <Spinner className="text-muted-foreground size-3.5 shrink-0" />
                ) : (
                  <Plus className="text-muted-foreground size-3.5 shrink-0" />
                )}
                <span className="text-foreground min-w-0 flex-1 truncate text-sm">{r.name}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Add-by-git-URL (BRO-1629 slice 5) — clone a public repo into the projects
          root. The engine owns validation (https + host allowlist + no creds); here
          we only block an empty submit. */}
      <form onSubmit={doAddByUrl} className="space-y-1.5 pt-1">
        <label htmlFor="ws-git-url" className="text-muted-foreground text-xs">
          Clone from a git URL
        </label>
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <GitBranch className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input
              id="ws-git-url"
              type="url"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="https://github.com/owner/repo"
              value={url}
              disabled={addingUrl}
              onChange={(e) => setUrl(e.target.value)}
              className="h-9 pl-8 text-sm"
            />
          </div>
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={addingUrl || url.trim().length === 0}
            className="shrink-0"
          >
            {addingUrl ? <Spinner className="size-3.5" /> : "Clone"}
          </Button>
        </div>
      </form>

      {error ? <p className="text-destructive text-xs leading-snug">{error}</p> : null}
    </section>
  );
}
