"use client";

import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ThreadPhase, ThreadSummary } from "@/lib/threads";
import { cn } from "@/lib/utils";

// Phase → status-dot color (arcan-glass tokens). Mirrors the StatusPill palette.
const PHASE_DOT: Record<ThreadPhase, string> = {
  running: "bg-[var(--ai-blue)]",
  awaiting: "bg-[var(--amber)]",
  blocked: "bg-destructive",
  done: "bg-[var(--success)]",
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
          "bg-panel border-border z-40 flex w-72 shrink-0 flex-col border-r",
          "fixed inset-y-0 left-0 transition-transform duration-200 md:static md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="border-border flex items-center gap-2 border-b px-3 py-3">
          <span className="font-mono text-sm font-semibold tracking-tight text-[var(--ai-blue)]">
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

        <nav className="min-h-0 flex-1 overflow-y-auto p-2">
          {threads.length === 0 ? (
            <p className="text-muted-foreground px-2 py-6 text-center font-mono text-xs">
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
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground hover:bg-accent/50",
                      )}
                    >
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          PHASE_DOT[t.phase] ?? PHASE_DOT.idle,
                        )}
                      />
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
