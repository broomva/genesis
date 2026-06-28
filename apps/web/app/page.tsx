"use client";

import type { UIMessage } from "ai";
import { useCallback, useEffect, useState } from "react";

import { ChatView } from "@/components/chat-view";
import { ThreadDrawer } from "@/components/thread-drawer";
import { DEFAULT_EFFORT, DEFAULT_MODEL } from "@/lib/chat-options";
import { type ThreadSummary, fetchThreadMessages, fetchThreads } from "@/lib/threads";

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
    if (m) setModel(m);
    const e = localStorage.getItem(EFFORT_KEY);
    if (e) setEffort(e);
  }, []);

  const onModelChange = useCallback((value: string) => {
    setModel(value);
    localStorage.setItem(MODEL_KEY, value);
  }, []);

  const onEffortChange = useCallback((value: string) => {
    setEffort(value);
    localStorage.setItem(EFFORT_KEY, value);
  }, []);

  const refreshThreads = useCallback(async () => {
    setThreads(await fetchThreads());
  }, []);

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

  return (
    <div className="bg-background text-foreground flex h-dvh overflow-hidden">
      <ThreadDrawer
        threads={threads}
        activeThreadId={activeThreadId}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSelect={selectThread}
        onNew={newThread}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {activeThreadId && initialMessages !== null ? (
          <ChatView
            key={activeThreadId}
            threadId={activeThreadId}
            initialMessages={initialMessages}
            onActivity={onActivity}
            onMenuClick={() => setDrawerOpen(true)}
            model={model}
            effort={effort}
            onModelChange={onModelChange}
            onEffortChange={onEffortChange}
          />
        ) : (
          <div className="text-muted-foreground flex flex-1 items-center justify-center font-mono text-sm">
            loading…
          </div>
        )}
      </div>
    </div>
  );
}
