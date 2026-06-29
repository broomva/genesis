"use client";

import {
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { ThreadPhase, ThreadSummary } from "@/lib/threads";
import { cn } from "@/lib/utils";

// Phase → status-dot fill (DS cool-axis status hues, color-status.html). `running`
// is special-cased to the tidepool dot (bv-dot-live) in the row, so it's omitted.
// DS canon (SKILL.md authoritative, BRO-1592): halts read in accent-blue ("Needs
// you"), not red; reserve danger for true failures. So awaiting → blue-accent,
// blocked ("Stuck") → warning.
// DS plain voice for the status dot's accessible name (SKILL.md: system enums
// are a developer surface; users — incl. screen-reader users — get plain
// language). The dot conveys status by colour, so this is its text alternative.
const PHASE_LABEL: Record<ThreadPhase, string> = {
  idle: "Queued",
  running: "Running",
  awaiting: "Needs you",
  blocked: "Stuck",
  done: "Done",
};

const PHASE_DOT: Record<Exclude<ThreadPhase, "running">, string> = {
  awaiting: "bg-[var(--bv-blue-accent)]",
  blocked: "bg-[var(--bv-warning)]",
  done: "bg-[var(--bv-success)]",
  idle: "bg-muted-foreground/40",
};

/** The drawer row label: the title (auto-derived or renamed) wins; else a
 *  collapsed last-text preview; else a new-conversation placeholder. */
function rowLabel(t: ThreadSummary): string {
  const title = t.title?.trim();
  if (title) return title;
  const s = t.lastText?.trim();
  if (!s) return "New conversation";
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length > 48 ? `${oneLine.slice(0, 48)}…` : oneLine;
}

/** One thread row — a container div (NOT a button, so the ⋯ menu trigger can
 *  nest without an invalid button-in-button) holding the navigate target + a
 *  persistent actions menu. The ⋯ is always present (DS: no hover-only
 *  affordances), just quiet until hovered/focused. */
function ThreadRow({
  t,
  isActive,
  onSelect,
  onArchive,
  onRename,
  onRequestDelete,
}: {
  t: ThreadSummary;
  isActive: boolean;
  onSelect: (threadId: string) => void;
  onArchive: (threadId: string, archived: boolean) => void;
  onRename: (t: ThreadSummary) => void;
  onRequestDelete: (t: ThreadSummary) => void;
}) {
  const label = rowLabel(t);
  return (
    <div
      className={cn(
        "group/row flex items-center gap-0.5 rounded-lg pr-1 transition-colors",
        isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
        t.archived && "opacity-70",
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(t.threadId)}
        aria-current={isActive ? "true" : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm",
          isActive ? "text-sidebar-accent-foreground" : "text-foreground",
        )}
      >
        {/* The dot carries phase by color — give it an accessible name so status
            isn't conveyed by color alone (WCAG 1.4.1). */}
        {t.phase === "running" ? (
          <span className="bv-dot-live shrink-0" role="img" aria-label={PHASE_LABEL.running} />
        ) : (
          <span
            role="img"
            aria-label={PHASE_LABEL[t.phase] ?? PHASE_LABEL.idle}
            className={cn("size-1.5 shrink-0 rounded-full", PHASE_DOT[t.phase] ?? PHASE_DOT.idle)}
          />
        )}
        <span className="truncate">{label}</span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Conversation actions"
            className={cn(
              // At-rest contrast must clear the WCAG 1.4.11 3:1 non-text floor —
              // /80 (not /60) keeps the glyph legible while still quiet (DS: no
              // hover-only affordances, so it's always visible).
              "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/80 transition-colors",
              "hover:bg-[var(--bv-frost-8)] hover:text-foreground focus-visible:text-foreground",
              "data-[state=open]:bg-[var(--bv-frost-8)] data-[state=open]:text-foreground",
              "[@media(pointer:coarse)]:size-9",
            )}
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onSelect={() => onRename(t)}>
            <Pencil className="size-3.5" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onArchive(t.threadId, !t.archived)}>
            {t.archived ? (
              <>
                <ArchiveRestore className="size-3.5" />
                Unarchive
              </>
            ) : (
              <>
                <Archive className="size-3.5" />
                Archive
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* Delete is the one place danger hue appears — and only as text, on the
              menu item; the actual destruction is gated behind a confirm dialog. */}
          <DropdownMenuItem variant="destructive" onSelect={() => onRequestDelete(t)}>
            <Trash2 className="size-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Left sidebar listing threads — now a session manager (BRO-1592): search,
 *  archive, delete, rename. Persistent on md+; a slide-in overlay on mobile
 *  (toggled via `open`/`onClose`). `activeThreadId` highlights the current thread;
 *  it may be absent from `threads` if it's a brand-new, never-sent conversation. */
export function ThreadDrawer({
  threads,
  activeThreadId,
  open,
  onClose,
  onSelect,
  onNew,
  onArchive,
  onDelete,
  onRename,
}: {
  threads: ThreadSummary[];
  activeThreadId: string | null;
  open: boolean;
  onClose: () => void;
  onSelect: (threadId: string) => void;
  onNew: () => void;
  onArchive: (threadId: string, archived: boolean) => void;
  onDelete: (threadId: string) => void;
  onRename: (threadId: string, title: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ThreadSummary | null>(null);
  const [renaming, setRenaming] = useState<ThreadSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const archivedCount = useMemo(() => threads.filter((t) => t.archived).length, [threads]);

  // Client-side filter (BRO-1592): match the query over the row label, split into
  // active vs archived. Cheap at single-user scale — the list is already fetched.
  const { active, archived } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (t: ThreadSummary) => !q || rowLabel(t).toLowerCase().includes(q);
    const hit = threads.filter(matches);
    return {
      active: hit.filter((t) => !t.archived),
      archived: hit.filter((t) => t.archived),
    };
  }, [threads, query]);

  function startRename(t: ThreadSummary) {
    setRenameValue(t.title ?? "");
    setRenaming(t);
  }
  function commitRename() {
    if (renaming) onRename(renaming.threadId, renameValue.trim());
    setRenaming(null);
  }
  function commitDelete() {
    if (confirmDelete) onDelete(confirmDelete.threadId);
    setConfirmDelete(null);
  }

  const rowProps = {
    onSelect,
    onArchive,
    onRename: startRename,
    onRequestDelete: setConfirmDelete,
  };

  return (
    <>
      {/* Mobile backdrop — tap to dismiss. Hidden on md+ (sidebar is persistent). */}
      {open ? (
        <button
          type="button"
          aria-label="Close conversations"
          className="bv-scrim fixed inset-0 z-30 md:hidden"
          onClick={onClose}
        />
      ) : null}

      <aside
        className={cn(
          // Matte sidebar — the DS keeps chrome matte; glass is earned only by the
          // composer, overlays and popovers.
          "bg-sidebar border-sidebar-border z-40 flex w-72 shrink-0 flex-col border-r",
          "fixed inset-y-0 left-0 transition-transform duration-200 md:static md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="border-sidebar-border flex items-center gap-2 border-b px-3 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] md:pt-3">
          <span className="text-foreground text-[0.95rem] font-medium tracking-tight">Genesis</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto [@media(pointer:coarse)]:h-11"
            onClick={onNew}
            aria-label="New conversation"
          >
            <Plus className="size-3.5" />
            New
          </Button>
        </div>

        {/* Search pill (DS inputs.html .search) — soft canvas, rounded-full, matte. */}
        <div className="px-2.5 pt-2.5 pb-1">
          <div className="bg-[var(--bv-canvas-soft-2)] flex h-9 items-center gap-2 rounded-full px-3 transition-shadow focus-within:ring-2 focus-within:ring-ring/60">
            <Search className="text-muted-foreground size-4 shrink-0" aria-hidden />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                // ≥24px hit area (WCAG 2.5.8), bumped to 44px on coarse pointers.
                className="text-muted-foreground hover:text-foreground -mr-1.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md [@media(pointer:coarse)]:size-11"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
          {active.length === 0 && archived.length === 0 ? (
            <p className="text-muted-foreground px-2 py-6 text-center text-xs">
              {query.trim() ? "No matches." : "No conversations yet."}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {active.map((t) => (
                <li key={t.threadId}>
                  <ThreadRow t={t} isActive={t.threadId === activeThreadId} {...rowProps} />
                </li>
              ))}
            </ul>
          )}

          {/* Archived section — collapsed by default; the toggle appears only when
              archived threads exist. */}
          {archivedCount > 0 ? (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium tracking-wide transition-colors"
                aria-expanded={showArchived}
              >
                <Archive className="size-3" />
                {showArchived ? "Hide" : "Show"} archived ({archivedCount})
              </button>
              {/* A query reveals archived matches even when collapsed — otherwise
                  searching for a thread that's been archived would find nothing. */}
              {showArchived || query.trim() ? (
                <ul className="mt-1 flex flex-col gap-1">
                  {archived.map((t) => (
                    <li key={t.threadId}>
                      <ThreadRow t={t} isActive={t.threadId === activeThreadId} {...rowProps} />
                    </li>
                  ))}
                  {archived.length === 0 ? (
                    <p className="text-muted-foreground px-2 py-2 text-center text-xs">
                      No archived matches.
                    </p>
                  ) : null}
                </ul>
              ) : null}
            </div>
          ) : null}
        </nav>
      </aside>

      {/* Delete confirm — Radix Dialog portals to body (escapes the sidebar's
          transform containing block). Lives at the drawer root, opened by state
          from the row menu (the focus-safe pattern, not nested in the menu). */}
      <Dialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete conversation</DialogTitle>
            <DialogDescription>
              This permanently deletes “{confirmDelete ? rowLabel(confirmDelete) : ""}” and all its
              messages. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={commitDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename */}
      <Dialog open={renaming !== null} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
            <DialogDescription>
              A short title for this thread. Leave empty to reset.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              }
            }}
            placeholder="Conversation title"
            aria-label="Conversation title"
            autoFocus
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={commitRename}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
