// The channel handler: a chat message → Genesis agent reply, streamed back into
// the thread. Decoupled from the full Chat SDK `Thread` via a minimal interface
// so it is unit-testable with a mock thread.
//
// Control commands (BRO-1493): a leading-slash control command (/new, /stop,
// /status, /commands, /help) is handled HERE — mapped to the Genesis /control
// surface or a local reply — and never forwarded to the agent. Telegram delivers
// commands as normal messages (no SlashCommandEvent), so routing lives in the
// one handler every message flows through. Skill commands (/autonomous, …) are
// NOT control commands, so they fall through and run in the session as a turn.

import {
  CONTROL_COMMANDS,
  controlAction,
  enumerateSessionCommands,
  renderCommandList,
  renderHelp,
} from "./commands";
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
  /** Skills dirs for /commands enumeration (default: the user skills dir). */
  skillsDirs?: string[];
}

/** Parse a leading-slash command token + args, stripping a `@botname` suffix. */
export function parseCommand(text: string): { token: string; args: string } | undefined {
  const m = text.trim().match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (m?.[1] === undefined) return undefined;
  return { token: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
}

/** POST a /control action to Genesis. Returns the parsed JSON result. */
async function genesisControl(
  action: string,
  threadId: string,
  opts: HandlerOptions,
): Promise<{ ok: boolean; reason?: string; phase?: string; alive?: boolean }> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl}/control`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: JSON.stringify({ threadId, action }),
  });
  return (await res.json().catch(() => ({ ok: false }))) as {
    ok: boolean;
    reason?: string;
    phase?: string;
    alive?: boolean;
  };
}

/** Handle a control command. Returns true if it WAS a control command (handled
 *  here); false → not a control command, caller should dispatch to the agent. */
export async function handleControlCommand(
  thread: PostableThread,
  text: string,
  opts: HandlerOptions,
): Promise<boolean> {
  const parsed = parseCommand(text);
  if (parsed === undefined) return false;
  const action = controlAction(parsed.token);
  if (action === undefined) return false; // a skill/unknown command → not control

  switch (action) {
    case "help":
      await thread.post(renderHelp());
      return true;
    case "commands":
      await thread.post(
        renderCommandList(enumerateSessionCommands({ skillsDirs: opts.skillsDirs })),
      );
      return true;
    case "new": {
      const r = await genesisControl("reset", thread.id, opts);
      await thread.post(
        r.ok
          ? "🆕 Fresh conversation started — I've cleared my context for this chat."
          : "🆕 Nothing to reset yet — just send a message to begin.",
      );
      return true;
    }
    case "stop": {
      const r = await genesisControl("interrupt", thread.id, opts);
      await thread.post(r.ok ? "⏹️ Interrupted the current turn." : "Nothing is running right now.");
      return true;
    }
    case "status": {
      const r = await genesisControl("status", thread.id, opts);
      if (!r.ok) {
        await thread.post("No active session for this chat yet — send a message to start one.");
        return true;
      }
      await thread.post(`Session: *${r.alive ? "live" : "idle"}* · phase: \`${r.phase ?? "?"}\``);
      return true;
    }
    default:
      return false;
  }
}

/** Telegram setMyCommands payload for the native `/` menu (control set only). */
export function nativeCommandMenu(): Array<{ command: string; description: string }> {
  return CONTROL_COMMANDS.map((c) => ({ command: c.command, description: c.description }));
}

/** Stream a Genesis agent reply into `thread`, keyed to the thread's id for
 *  per-conversation continuity. Control commands are handled first; everything
 *  else (including skill commands) dispatches to the agent. Surfaces a failure
 *  as a posted message rather than throwing, so one bad turn never crashes. */
export async function handleAgentMessage(
  thread: PostableThread,
  text: string,
  opts: HandlerOptions,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  // Control commands short-circuit (never reach the agent).
  if (await handleControlCommand(thread, trimmed, opts).catch(() => false)) return;

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
    console.error("[genesis-bot] dispatch failed", e);
    await thread.post("⚠️ Something went wrong handling that — please try again.").catch(() => {});
  }
}
