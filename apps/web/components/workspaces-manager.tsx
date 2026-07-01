"use client";

import { FolderGit2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  onRemove,
}: {
  workspaces: Workspace[];
  /** The server default id — protected from removal (the engine rejects it too). */
  defaultWorkspaceId: string;
  /** Register a picked dir; the parent refreshes the workspace list on success. */
  onAdd: (pick: string) => Promise<AddWorkspaceResult>;
  /** De-register; the parent refreshes the workspace list on success. */
  onRemove: (id: string) => Promise<boolean>;
}) {
  const [available, setAvailable] = useState<AvailableRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addingName, setAddingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async (signal?: AbortSignal) => {
    const repos = await fetchAvailableWorkspaces(signal);
    if (!signal?.aborted) setAvailable(repos);
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
      setAddingName(pick);
      const res = await onAdd(pick);
      setAddingName(null);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await refetch(); // the just-added repo drops off the available list
    },
    [onAdd, refetch],
  );

  const doRemove = useCallback(
    async (id: string) => {
      setError(null);
      setBusyId(id);
      const ok = await onRemove(id);
      setBusyId(null);
      if (!ok) {
        setError("Could not remove this project. It may be in use.");
        return;
      }
      await refetch(); // the de-registered repo returns to the available list
    },
    [onRemove, refetch],
  );

  // Nothing to manage AND nothing to add → stay invisible (single-workspace
  // deploys are unchanged). Once loaded, if only the default exists and no repo
  // is discoverable, render nothing.
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
          const removing = busyId === w.id;
          return (
            <div
              key={w.id}
              className="border-border/60 bg-muted/30 flex items-center gap-2.5 rounded-lg border px-3 py-2"
            >
              <span className="text-foreground min-w-0 flex-1 truncate text-sm">{w.name}</span>
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
            const adding = addingName === r.name;
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

      {error ? <p className="text-destructive text-xs leading-snug">{error}</p> : null}
    </section>
  );
}
