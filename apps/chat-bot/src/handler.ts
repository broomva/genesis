// The channel handler: a chat message → Genesis agent reply, streamed back into
// the thread. Decoupled from the full Chat SDK `Thread` via a minimal interface
// so it is unit-testable with a mock thread.

import { genesisStream } from "./genesis";

/** The slice of Chat SDK's `Thread` this handler needs. */
export interface PostableThread {
  /** Stable conversation id → Genesis session (continuity). */
  readonly id: string;
  /** Post a string or stream an AsyncIterable<string> (post+edit on Telegram). */
  post(content: string | AsyncIterable<string>): Promise<unknown>;
  /** Optional typing indicator. */
  startTyping?(): Promise<unknown>;
}

export interface HandlerOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

/** Stream a Genesis agent reply into `thread`, keyed to the thread's id for
 *  per-conversation continuity. Surfaces a failure as a posted message rather
 *  than throwing, so one bad turn never crashes the bot. */
export async function handleAgentMessage(
  thread: PostableThread,
  text: string,
  opts: HandlerOptions,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  await thread.startTyping?.().catch(() => {});
  try {
    await thread.post(
      genesisStream({
        baseUrl: opts.baseUrl,
        threadId: thread.id,
        text: trimmed,
        token: opts.token,
        fetchImpl: opts.fetchImpl,
      }),
    );
  } catch (e) {
    // Log the real cause; show the user a generic message rather than leaking
    // SDK-internal error strings into the chat.
    console.error("[genesis-bot] dispatch failed", e);
    await thread.post("⚠️ Something went wrong handling that — please try again.").catch(() => {});
  }
}
