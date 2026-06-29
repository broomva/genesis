"use client";

import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChatView } from "@/components/chat-view";
import { ThreadDrawer } from "@/components/thread-drawer";
import { DEFAULT_EFFORT, DEFAULT_MODEL, isKnownEffort, isKnownModel } from "@/lib/chat-options";
import {
  type ThreadSummary,
  archiveThread,
  deleteThread,
  fetchThreadMessages,
  fetchThreads,
  renameThread,
} from "@/lib/threads";

// localStorage keys — active thread (restore the conversation on reload) + the
// model/effort selection (sticky across threads + reloads). Owned here, not in
// ChatView, because ChatView remounts per thread (key=threadId).
const ACTIVE_KEY = "genesis:active-thread";
const MODEL_KEY = "genesis:model";
const EFFORT_KEY = "genesis:effort";

export default function ChatPage() {
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  // null = hydrating (history not loaded yet) → show a loader, not the empty state.
  const [initialMessages, setInitialMessages] = useState<UIMessage[] | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [effort, setEffort] = useState(DEFAULT_EFFORT);

  // Restore (or mint) the active thread id + the model/effort selection.
  // Client-only: crypto + localStorage are unavailable during SSR, so this runs
  // in an effect, not render (the selects render the default first, then settle).
  useEffect(() => {
    const stored = localStorage.getItem(ACTIVE_KEY);
    const id = stored ?? crypto.randomUUID();
    if (!stored) localStorage.setItem(ACTIVE_KEY, id);
    setActiveThreadId(id);
    const m = localStorage.getItem(MODEL_KEY);
    if (isKnownModel(m)) setModel(m);
    const e = localStorage.getItem(EFFORT_KEY);
    if (isKnownEffort(e)) setEffort(e);
  }, []);

  const onModelChange = useCallback((value: string) => {
    setModel(value);
    localStorage.setItem(MODEL_KEY, value);
  }, []);

  const onEffortChange = useCallback((value: string) => {
    setEffort(value);
    localStorage.setItem(EFFORT_KEY, value);
  }, []);

  // Optimistic-mutation overrides (BRO-1592, P20 F14/F15/F16). archive/rename
  // write on the server BEHIND the per-thread dispatch chain — so for a thread
  // that is itself running, the write lands only after the turn ends. Meanwhile
  // the freshness poll full-replaces `threads` with server truth, which would
  // revert the optimistic update for the whole turn. So: hold a per-thread
  // override, re-apply it on every refresh, and self-clear it once the server
  // confirms (or the mutation fails).
  const pendingRef = useRef<Map<string, { archived?: boolean; title?: string; deleted?: boolean }>>(
    new Map(),
  );

  const reconcile = useCallback((server: ThreadSummary[]): ThreadSummary[] => {
    const pend = pendingRef.current;
    for (const [id, ov] of [...pend]) {
      const row = server.find((t) => t.threadId === id);
      if (ov.deleted) {
        if (!row) pend.delete(id); // delete confirmed once the row is gone
      } else if (
        row &&
        (ov.archived === undefined || row.archived === ov.archived) &&
        (ov.title === undefined || (row.title ?? "") === (ov.title ?? ""))
      ) {
        pend.delete(id); // server caught up with the optimistic value
      }
    }
    return server
      .filter((t) => !pend.get(t.threadId)?.deleted)
      .map((t) => {
        const ov = pend.get(t.threadId);
        if (!ov) return t;
        return {
          ...t,
          ...(ov.archived !== undefined ? { archived: ov.archived } : {}),
          ...("title" in ov ? { title: ov.title } : {}),
        };
      });
  }, []);

  const refreshThreads = useCallback(async () => {
    setThreads(reconcile(await fetchThreads()));
  }, [reconcile]);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  // Hydrate the active thread's transcript whenever it changes. ChatView is
  // remounted by key once messages are ready, so useChat seeds with them.
  useEffect(() => {
    if (!activeThreadId) return;
    const ctrl = new AbortController();
    setInitialMessages(null);
    fetchThreadMessages(activeThreadId, ctrl.signal)
      .then((msgs) => setInitialMessages(msgs))
      .catch(() => setInitialMessages([]));
    return () => ctrl.abort();
  }, [activeThreadId]);

  const persistActive = useCallback((id: string) => {
    setActiveThreadId(id);
    localStorage.setItem(ACTIVE_KEY, id);
    setDrawerOpen(false);
  }, []);

  const selectThread = useCallback(
    (id: string) => {
      if (id !== activeThreadId) persistActive(id);
      else setDrawerOpen(false);
    },
    [activeThreadId, persistActive],
  );

  const newThread = useCallback(() => persistActive(crypto.randomUUID()), [persistActive]);

  const onActivity = useCallback(() => {
    void refreshThreads();
  }, [refreshThreads]);

  // --- Session management (BRO-1592). Optimistic local update, then the mutation,
  // then a refresh to reconcile with the engine's truth.

  const onArchive = useCallback(
    async (threadId: string, archived: boolean) => {
      const pend = pendingRef.current;
      pend.set(threadId, { ...pend.get(threadId), archived });
      setThreads((prev) => prev.map((t) => (t.threadId === threadId ? { ...t, archived } : t)));
      const ok = await archiveThread(threadId, archived);
      if (!ok) pend.delete(threadId); // drop the override → next refresh shows truth
      void refreshThreads();
    },
    [refreshThreads],
  );

  const onRename = useCallback(
    async (threadId: string, title: string) => {
      const next = title || undefined;
      const pend = pendingRef.current;
      pend.set(threadId, { ...pend.get(threadId), title: next });
      setThreads((prev) => prev.map((t) => (t.threadId === threadId ? { ...t, title: next } : t)));
      const ok = await renameThread(threadId, title);
      if (!ok) pend.delete(threadId);
      void refreshThreads();
    },
    [refreshThreads],
  );

  const onDelete = useCallback(
    async (threadId: string) => {
      // Await the delete BEFORE switching away / removing the row (P20 F14): a
      // failed delete must not strand the user on a minted thread while the old
      // one resurrects on the next refresh.
      const ok = await deleteThread(threadId);
      if (!ok) {
        void refreshThreads();
        return;
      }
      pendingRef.current.set(threadId, { deleted: true });
      setThreads((prev) => prev.filter((t) => t.threadId !== threadId));
      if (threadId === activeThreadId) newThread();
      void refreshThreads();
    },
    [activeThreadId, newThread, refreshThreads],
  );

  // Status freshness (BRO-1596): the drawer otherwise only refreshes on a turn
  // finishing here. While any thread is live (running/awaiting) its phase can
  // change out-of-band, so poll on a short cadence — but only while the tab is
  // visible and only while something is actually live (idle/done need no poll).
  const hasLiveThread = threads.some((t) => t.phase === "running" || t.phase === "awaiting");
  useEffect(() => {
    if (!hasLiveThread) return;
    const id = setInterval(() => {
      if (!document.hidden) void refreshThreads();
    }, 4000);
    return () => clearInterval(id);
  }, [hasLiveThread, refreshThreads]);

  // `fixed inset-0` (below) pins the app to the viewport (ICB) directly — the
  // bulletproof full-screen technique for iOS standalone PWAs, where `100dvh`
  // under-resolves (reports shorter than the real screen → a dark band below the
  // composer, BRO-1582). Header/footer carry the safe-area insets.
  return (
    <div className="bg-background text-foreground fixed inset-0 flex overflow-hidden">
      <ThreadDrawer
        threads={threads}
        activeThreadId={activeThreadId}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSelect={selectThread}
        onNew={newThread}
        onArchive={onArchive}
        onDelete={onDelete}
        onRename={onRename}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {activeThreadId && initialMessages !== null ? (
          <ChatView
            key={activeThreadId}
            threadId={activeThreadId}
            initialMessages={initialMessages}
            onActivity={onActivity}
            onMenuClick={() => setDrawerOpen(true)}
            onNewThread={newThread}
            model={model}
            effort={effort}
            onModelChange={onModelChange}
            onEffortChange={onEffortChange}
          />
        ) : (
          <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
            Loading…
          </div>
        )}
      </div>
    </div>
  );
}
