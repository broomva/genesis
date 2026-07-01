"use client";

import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChatView } from "@/components/chat-view";
import { SettingsSheet } from "@/components/settings-sheet";
import { ThreadDrawer } from "@/components/thread-drawer";
import {
  type ThreadSummary,
  archiveThread,
  deleteThread,
  fetchThreadMessages,
  fetchThreads,
  renameThread,
} from "@/lib/threads";
import { usePreferences } from "@/lib/use-preferences";
import {
  type Workspace,
  addWorkspace,
  fetchWorkspaces,
  removeWorkspace,
  resolveWorkspace,
} from "@/lib/workspaces";

// localStorage key for the active thread (restore the conversation on reload).
// Owned here, not in ChatView, because ChatView remounts per thread (key=threadId).
// Preference keys (model/effort/theme/show-reasoning) now live in usePreferences.
const ACTIVE_KEY = "genesis:active-thread";

export default function ChatPage() {
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  // null = hydrating (history not loaded yet) → show a loader, not the empty state.
  const [initialMessages, setInitialMessages] = useState<UIMessage[] | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Selectable workspaces (BRO-1627) — fetched once; the per-thread picker offers
  // these and self-hides when there's ≤1. `defaultWorkspaceId` is the server's
  // fallback (what a thread binds when none is chosen).
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [defaultWorkspaceId, setDefaultWorkspaceId] = useState("");
  // The one source of truth for prefs (model, effort, theme, show-reasoning) —
  // localStorage fast-path + server sync (BRO-1618). The composer toolbar and the
  // settings sheet both bind here.
  const { prefs, update } = usePreferences();

  // Restore (or mint) the active thread id. Client-only: crypto + localStorage are
  // unavailable during SSR, so this runs in an effect, not render.
  useEffect(() => {
    const stored = localStorage.getItem(ACTIVE_KEY);
    const id = stored ?? crypto.randomUUID();
    if (!stored) localStorage.setItem(ACTIVE_KEY, id);
    setActiveThreadId(id);
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

  // Fetch the selectable workspaces (BRO-1627). On failure the list stays empty
  // and the picker self-hides (single-workspace behavior, unchanged). Extracted
  // so add/remove (BRO-1629 slice 3) can re-pull the live list after mutating.
  const refreshWorkspaces = useCallback(async (signal?: AbortSignal) => {
    const list = await fetchWorkspaces(signal);
    if (signal?.aborted) return;
    setWorkspaces(list.workspaces);
    setDefaultWorkspaceId(list.defaultWorkspace);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    refreshWorkspaces(ctrl.signal).catch(() => {});
    return () => ctrl.abort();
  }, [refreshWorkspaces]);

  // Self-serve workspace add/remove (BRO-1629 slice 3) — register a discovered
  // repo or de-register one, then re-pull the live list so the composer picker,
  // default-workspace pref, and manager all reflect the change without a reload.
  const onAddWorkspace = useCallback(
    async (pick: string) => {
      const res = await addWorkspace(pick);
      if (res.ok) await refreshWorkspaces();
      return res;
    },
    [refreshWorkspaces],
  );

  const onRemoveWorkspace = useCallback(
    async (id: string) => {
      const ok = await removeWorkspace(id);
      if (ok) await refreshWorkspaces();
      return ok;
    },
    [refreshWorkspaces],
  );

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
  // The active thread's BOUND engine gates the composer's per-turn controls
  // (BRO-1620 P20 F) and routes the effort pref to the right PROVIDER slot
  // (BRO-1623 P20): codex effort is a separate pref from claude effort, so a
  // codex pick never clobbers the claude one. A never-run thread inherits the
  // global default engine until its first turn binds it.
  const activeThread = threads.find((t) => t.threadId === activeThreadId);
  const activeEngine = activeThread?.engine ?? prefs.engine;
  const activeEffort = activeEngine === "codex" ? prefs.codexEffort : prefs.effort;
  const setActiveEffort = (value: string) =>
    update(activeEngine === "codex" ? { codexEffort: value } : { effort: value });
  // The active thread's workspace (BRO-1627): its bound id once it has run, else
  // the user's default pref, else the server default — clamped to the live list so
  // a stale id never selects nothing. A new thread can change it until its first
  // turn binds it (the composer picker locks after).
  const activeWorkspace = resolveWorkspace(
    activeThread?.workspaceId,
    prefs.workspace,
    defaultWorkspaceId,
    workspaces,
  );

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
        onOpenSettings={() => {
          setDrawerOpen(false);
          setSettingsOpen(true);
        }}
        showWorkspace={workspaces.length > 1}
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
            model={prefs.model}
            effort={activeEffort}
            onModelChange={(value) => update({ model: value })}
            onEffortChange={setActiveEffort}
            showReasoning={prefs.showReasoning}
            theme={prefs.theme}
            onThemeChange={(theme) => update({ theme })}
            engine={activeEngine}
            workspace={activeWorkspace}
            workspaces={workspaces}
            onWorkspaceChange={(value) => update({ workspace: value })}
          />
        ) : (
          <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
            Loading…
          </div>
        )}
      </div>

      <SettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        prefs={prefs}
        onUpdate={update}
        workspaces={workspaces}
        defaultWorkspaceId={defaultWorkspaceId}
        onAddWorkspace={onAddWorkspace}
        onRemoveWorkspace={onRemoveWorkspace}
      />
    </div>
  );
}
