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
  /** Auto-derived/renamed title (BRO-1592); drawer falls back to lastText. */
  title?: string;
  /** Soft-archived → hidden from the default list (BRO-1592). */
  archived?: boolean;
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

/** POST a /control action to the BFF (shared by reset/archive/rename, BRO-1592).
 *  Returns true on a 2xx. The BFF forwards the body verbatim to the engine. */
async function control(body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch("/api/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Reset a thread's agent session (BRO-1576) — next turn starts with fresh
 *  context (same thread). Returns true on success. */
export function resetThread(threadId: string): Promise<boolean> {
  return control({ threadId, action: "reset" });
}

/** Soft-archive (true) or restore (false) a thread (BRO-1592). */
export function archiveThread(threadId: string, archived: boolean): Promise<boolean> {
  return control({ threadId, action: archived ? "archive" : "unarchive" });
}

/** Rename a thread (BRO-1592); empty title clears it back to the preview. */
export function renameThread(threadId: string, title: string): Promise<boolean> {
  return control({ threadId, action: "rename", title });
}

/** Hard-delete a thread + transcript (BRO-1592) via DELETE /api/threads/:id.
 *  Irreversible. Returns true on success. */
export async function deleteThread(threadId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}
