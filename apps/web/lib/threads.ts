// Client helpers for the thread drawer + history hydration (BRO-1567). Talks to
// the BFF proxies (/api/threads, /api/threads/:id) — never the engine directly.

import type { UIMessage } from "ai";

export type ThreadPhase = "idle" | "running" | "awaiting" | "blocked" | "done";

/** Mirror of the engine's ThreadSummary (packages/core Supervisor.listThreads). */
export interface ThreadSummary {
  threadId: string;
  phase: ThreadPhase;
  createdAt: string;
  lastText?: string;
}

interface Turn {
  id: string;
  role: "user" | "agent";
  text: string;
  createdAt: string;
}

/** Fetch the thread list for the drawer. Returns [] on any non-OK / error so the
 *  UI degrades to "no conversations" rather than throwing. */
export async function fetchThreads(signal?: AbortSignal): Promise<ThreadSummary[]> {
  const res = await fetch("/api/threads", { signal });
  if (!res.ok) return [];
  const data = (await res.json()) as { threads?: ThreadSummary[] };
  return data.threads ?? [];
}

/** Fetch one thread's transcript and map engine turns → AI SDK UIMessages for
 *  useChat hydration. Engine role "agent" → UI role "assistant". */
export async function fetchThreadMessages(
  threadId: string,
  signal?: AbortSignal,
): Promise<UIMessage[]> {
  const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}`, { signal });
  if (!res.ok) return [];
  const data = (await res.json()) as { turns?: Turn[] };
  return (data.turns ?? []).map(
    (t) =>
      ({
        id: t.id,
        role: t.role === "agent" ? "assistant" : "user",
        parts: [{ type: "text", text: t.text }],
      }) as UIMessage,
  );
}

/** Reset a thread's agent session (BRO-1576) via the /api/control BFF proxy — the
 *  next turn starts with fresh context (same thread). Returns true on success. */
export async function resetThread(threadId: string): Promise<boolean> {
  try {
    const res = await fetch("/api/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, action: "reset" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
