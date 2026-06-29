// Client helpers for the thread drawer + history hydration (BRO-1567). Talks to
// the BFF proxies (/api/threads, /api/threads/:id) — never the engine directly.

import type { UIMessage } from "ai";

export type ThreadPhase = "idle" | "running" | "awaiting" | "blocked" | "done";

/** Mirror of the engine's TokenUsage (packages/projection). Cache tokens are
 *  separate so the meter can sum input+cacheRead+cacheCreation for the real
 *  context-window fill (BRO-1597). */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Per-message metadata surfaced on `message.metadata` (live via the AI SDK
 *  message-metadata stream part, or hydrated from a persisted turn). */
export interface MessageMetadata {
  usage?: TokenUsage;
  costUsd?: number;
  /** Server-measured agent run time in ms (BRO-1610) — shown as "5m 24s" per turn. */
  durationMs?: number;
}

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

/** Mirror of the engine's TurnPart (packages/projection) — the persisted ordered
 *  timeline (BRO-1607). Tool calls rebuild as AI SDK dynamic-tool parts on reload. */
type StoredToolPart = {
  type: "tool";
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  state: "input-available" | "output-available" | "output-error";
};
type StoredPart = { type: "text"; text: string } | StoredToolPart;

interface Turn {
  id: string;
  role: "user" | "agent";
  text: string;
  createdAt: string;
  usage?: TokenUsage;
  costUsd?: number;
  /** Ordered text+tool timeline (BRO-1607). Absent on user turns / pre-1607 rows. */
  parts?: StoredPart[];
  /** Extended-thinking estimate (BRO-1607) → the `~N tokens` on the indicator. */
  thinkingTokens?: number;
  /** The model reasoned this turn (BRO-1608) → whether to rebuild the indicator,
   *  independent of the token count (0 at effort high). */
  reasoned?: boolean;
  /** Verbatim reasoning prose (BRO-1608) when a deployment provides it; absent
   *  under subscription auth (redacted) → falls back to the indicator note. */
  reasoning?: string;
  /** Server-measured run time in ms (BRO-1610). */
  durationMs?: number;
}

/** The reasoning content on reload (BRO-1608) — matches the engine's
 *  `reasoningNote` (apps/api/src/server.ts) for every turn it produces (prose →
 *  `~N tokens` → token-less indicator), so live ≡ reload. The extra tokens-only
 *  clause is reload-ONLY leniency: legacy BRO-1607 rows persisted `thinkingTokens`
 *  but not `reasoned`, and for any real turn tokens>0 implies the model reasoned,
 *  so it can never diverge from live (where `reasoned` is always set). */
function reasoningNote(
  reasoned: boolean | undefined,
  tokens: number | undefined,
  prose: string | undefined,
): string | undefined {
  if (prose && prose.trim().length > 0) return prose.trim();
  if (!reasoned && !(tokens && tokens > 0)) return undefined;
  return tokens && tokens > 0
    ? `Extended thinking · ~${tokens} tokens (content private on this deployment)`
    : "Extended thinking (content private on this deployment)";
}

/** A persisted tool part → an AI SDK dynamic-tool UIMessagePart (BRO-1607). The
 *  part union is wide and state-discriminated; build the right shape per state. */
function toDynamicToolPart(p: StoredToolPart): UIMessage["parts"][number] {
  const base = { type: "dynamic-tool" as const, toolName: p.toolName, toolCallId: p.toolCallId };
  if (p.state === "output-available") {
    return { ...base, state: "output-available", input: p.input, output: p.output };
  }
  if (p.state === "output-error") {
    return {
      ...base,
      state: "output-error",
      input: p.input,
      errorText: typeof p.output === "string" ? p.output : "Tool failed",
    };
  }
  return { ...base, state: "input-available", input: p.input };
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
  return (data.turns ?? []).map((t) => {
    const metadata: MessageMetadata | undefined =
      t.usage !== undefined || t.costUsd !== undefined || t.durationMs !== undefined
        ? { usage: t.usage, costUsd: t.costUsd, durationMs: t.durationMs }
        : undefined;
    // Rebuild the ordered parts (BRO-1607): reasoning indicator first (if the
    // turn did extended thinking), then the persisted text+tool timeline — so a
    // reloaded thread shows tool blocks + interleaving, not just the final text.
    // Pre-1607 rows (no `parts`) fall back to a single text part.
    const parts: UIMessage["parts"] = [];
    if (t.role === "agent") {
      const note = reasoningNote(t.reasoned, t.thinkingTokens, t.reasoning);
      if (note) parts.push({ type: "reasoning", text: note });
    }
    let hasBody = false;
    if (t.parts && t.parts.length > 0) {
      for (const p of t.parts) {
        if (p.type === "text") {
          if (p.text) {
            parts.push({ type: "text", text: p.text });
            hasBody = true;
          }
        } else {
          parts.push(toDynamicToolPart(p));
          hasBody = true;
        }
      }
    }
    if (!hasBody) {
      // No text/tool parts rebuilt (pre-1607 row, or a text-less timeline) — keep
      // the final text so the message is never empty.
      parts.push({ type: "text", text: t.text });
    }
    return {
      id: t.id,
      role: t.role === "agent" ? "assistant" : "user",
      parts,
      // Hydrate usage/cost (BRO-1597) so a reloaded thread keeps its running
      // total + latest context-window fill, not just live turns.
      ...(metadata ? { metadata } : {}),
    } as UIMessage;
  });
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
