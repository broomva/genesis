"use client";

import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ThreadPhase, ThreadSummary } from "@/lib/threads";
import { cn } from "@/lib/utils";

// Phase → status-dot fill (DS cool-axis status hues). `running` is special-cased
// to the tidepool dot (bv-dot-live) in the row, so it's omitted here.
const PHASE_DOT: Record<Exclude<ThreadPhase, "running">, string> = {
  awaiting: "bg-[var(--bv-warning)]",
  blocked: "bg-[var(--bv-danger)]",
  done: "bg-[var(--bv-success)]",
  idle: "bg-muted-foreground/40",
};

function previewLabel(t: ThreadSummary): string {
  const s = t.lastText?.trim();
  if (!s) return "New conversation";
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length > 48 ? `${oneLine.slice(0, 48)}…` : oneLine;
}

/** Left sidebar listing threads. Persistent on md+; a slide-in overlay on mobile
 *  (toggled via `open`/`onClose`). `activeThreadId` highlights the current thread;
 *  it may be absent from `threads` if it's a brand-new, never-sent conversation. */
export function ThreadDrawer({
  threads,
  activeThreadId,
  open,
  onClose,
  onSelect,
  onNew,
}: {
  threads: ThreadSummary[];
  activeThreadId: string | null;
  open: boolean;
  onClose: () => void;
  onSelect: (threadId: string) => void;
  onNew: () => void;
}) {
  return (
    <>
      {/* Mobile backdrop — tap to dismiss. Hidden on md+ (sidebar is persistent). */}
      {open ? (
        <button
          type="button"
          aria-label="Close conversations"
          className="bg-background/60 fixed inset-0 z-30 backdrop-blur-sm md:hidden"
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
          <span className="text-foreground text-[0.95rem] font-semibold tracking-tight">
            Genesis
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={onNew}
            aria-label="New conversation"
          >
            <Plus className="size-3.5" />
            New
          </Button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
          {threads.length === 0 ? (
            <p className="text-muted-foreground px-2 py-6 text-center text-xs">
              No conversations yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {threads.map((t) => {
                const isActive = t.threadId === activeThreadId;
                return (
                  <li key={t.threadId}>
                    <button
                      type="button"
                      onClick={() => onSelect(t.threadId)}
                      aria-current={isActive ? "true" : undefined}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                        isActive
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-foreground hover:bg-sidebar-accent/60",
                      )}
                    >
                      {/* The dot carries phase by color — give it an accessible
                          name so status isn't conveyed by color alone (WCAG 1.4.1). */}
                      {t.phase === "running" ? (
                        <span className="bv-dot-live shrink-0" role="img" aria-label="running" />
                      ) : (
                        <span
                          role="img"
                          aria-label={t.phase}
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            PHASE_DOT[t.phase] ?? PHASE_DOT.idle,
                          )}
                        />
                      )}
                      <span className="truncate">{previewLabel(t)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
      </aside>
    </>
  );
}
