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
  /** Pin this channel's sessions to a Genesis workspace (sticky at create).
   *  Set per channel, so a public channel can be confined to a dedicated
   *  workspace while another keeps the engine default. */
  workspaceId?: string;
  /** Whether this channel can render a streamed reply.
   *
   *  Chat SDK streams by posting a message and then EDITING it as tokens
   *  arrive. Telegram supports edits; WhatsApp does not — the Kapso adapter
   *  throws `NotImplementedError: WhatsApp Cloud API does not support editing
   *  sent messages` from `editMessage`, which aborts the whole turn AFTER the
   *  agent has already done the work. So a channel without edits gets the reply
   *  buffered and posted once (chunked to the text cap).
   *
   *  Defaults to true — Telegram's behavior is unchanged. */
  streaming?: boolean;
}

/** WhatsApp's text body cap. Chunk below it so a long reply is delivered rather
 *  than rejected; 3900 leaves room for the continuation marker. */
export const WHATSAPP_TEXT_LIMIT = 4096;
const CHUNK_TARGET = 3900;

/** Split a reply into WhatsApp-sized pieces, preferring paragraph then line
 *  breaks so chunks land on natural boundaries instead of mid-word.
 *
 *  Returns [] for empty input — the caller must not post an empty message
 *  (WhatsApp rejects it, and it would read as the agent replying with nothing). */
export function chunkForWhatsapp(text: string, limit: number = CHUNK_TARGET): string[] {
  const body = text.trim();
  if (!body) return [];
  if (body.length <= limit) return [body];

  const out: string[] = [];
  let rest = body;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Prefer a paragraph break, then a line break, then a space. `+ 1` keeps
    // the break character with the chunk being emitted.
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit * 0.5) cut = window.lastIndexOf("\n");
    if (cut < limit * 0.5) cut = window.lastIndexOf(" ");
    if (cut < limit * 0.5) cut = limit; // no good boundary — hard split
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter((c) => c.length > 0);
}

/** Drain an async text stream into one string. */
export async function drainStream(stream: AsyncIterable<string>): Promise<string> {
  let acc = "";
  for await (const piece of stream) acc += piece;
  return acc;
}

/** Which Genesis workspace a thread's sessions are pinned to (BRO-2216).
 *
 *  Pure so the confinement is testable — it is a security boundary, not a
 *  convenience. A WhatsApp number is publicly messageable, so its sessions are
 *  pinned to a dedicated workspace; every other channel keeps the engine
 *  default. The direction that matters is the negative one: the WhatsApp
 *  workspace must never be applied to a non-WhatsApp thread, and the absence of
 *  config must never silently widen a channel's reach.
 *
 *  Returns undefined to mean "inherit the engine default" — never a fallback
 *  workspace, because guessing here would be guessing about confinement. */
export function workspaceIdFor(
  threadId: string,
  whatsappWorkspaceId: string | undefined,
): string | undefined {
  if (!threadId.startsWith("kapso:")) return undefined;
  const pinned = whatsappWorkspaceId?.trim();
  return pinned ? pinned : undefined;
}

/** Is `wantId` present in a Genesis `GET /workspaces` payload?
 *
 *  Exists because the engine binds an UNKNOWN workspaceId to the DEFAULT
 *  workspace rather than refusing (`Supervisor.resolve`: "unknown → default").
 *  Measured on the VPS 2026-08-22: `workspaceId: "ws-doesnotexist"` ran the
 *  agent in `/home/agent` — the broadest workspace on the box.
 *
 *  For most callers that fallback is a convenience. For a PUBLIC channel it is
 *  a silent widening: one typo in GENESIS_WHATSAPP_WORKSPACE_ID and WhatsApp
 *  gets the home directory while the bot still logs "pinned". We do not change
 *  the engine's semantics (other consumers depend on them) — the channel
 *  verifies its own confinement before serving.
 *
 *  Unrecognizable payload → false. Unverifiable is not "fine". */
export function workspaceIsRegistered(payload: unknown, wantId: string): boolean {
  const want = wantId.trim();
  if (!want) return false;
  if (typeof payload !== "object" || payload === null) return false;
  const list = (payload as { workspaces?: unknown }).workspaces;
  if (!Array.isArray(list)) return false;
  return list.some((w) => {
    if (typeof w !== "object" || w === null) return false;
    const entry = w as { id?: unknown; available?: unknown };
    if (entry.id !== want) return false;
    // `available: false` means the path is missing/unreadable — registered but
    // unusable, which the engine would also fall back from.
    return entry.available !== false;
  });
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
    const stream = genesisStream({
      baseUrl: opts.baseUrl,
      threadId: thread.id,
      text: trimmed,
      token: opts.token,
      fetchImpl: opts.fetchImpl,
      workspaceId: opts.workspaceId,
    });
    if (opts.streaming === false) {
      // Buffered path: drain first, then post whole. Streaming here would post
      // a message and try to edit it, which this channel cannot do.
      const reply = await drainStream(stream);
      const chunks = chunkForWhatsapp(reply);
      if (chunks.length === 0) {
        // An empty reply must still say something — silence is indistinguishable
        // from the bot being down, which is the failure mode this whole channel
        // has to avoid.
        await thread.post("(the agent finished without producing any text)");
      } else {
        for (const chunk of chunks) await thread.post(chunk);
      }
    } else {
      await thread.post(stream);
    }
  } catch (e) {
    console.error("[genesis-bot] dispatch failed", e);
    await thread.post("⚠️ Something went wrong handling that — please try again.").catch(() => {});
  }
}
