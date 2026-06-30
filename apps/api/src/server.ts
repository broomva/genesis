import {
  type AgentEvent,
  type EngineControl,
  type Store,
  Supervisor,
  type Workspace,
} from "@genesis/core";
import type { HostProvider } from "@genesis/host";
import type { RunOptions, RunResult } from "@genesis/runner";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { eventStream } from "./channel/bridge";
import { ChatSdkConnector } from "./channel/chat-sdk";
import type { IncomingMessage } from "./channel/types";
import { Hub } from "./hub";
import { PAGE } from "./ui";

const { upgradeWebSocket, websocket } = createBunWebSocket();

/** Build the reasoning INDICATOR note (BRO-1574, hardened BRO-1608). Order:
 *  1) verbatim prose if the deployment ever provides it (the real streamed
 *     reasoning) — redacted to "" under subscription/OAuth auth, so usually skipped;
 *  2) else, if the model thought (`reasoned` — set by a signature_delta / thinking
 *     block even when no token estimate exists at effort high), the honest
 *     indicator, with the `~N tokens` budget when the CLI reported it (effort max).
 *  Undefined only when no extended thinking happened at all (effort off / low). */
function reasoningNote(
  reasoned: boolean | undefined,
  tokens: number | undefined,
  prose: string | undefined,
): string | undefined {
  if (prose && prose.trim().length > 0) return prose.trim();
  if (!reasoned) return undefined;
  return tokens && tokens > 0
    ? `Extended thinking · ~${tokens} tokens (content private on this deployment)`
    : "Extended thinking (content private on this deployment)";
}

export interface BuildOpts {
  workspaceRoot: string;
  extraArgs?: string[];
  /** When set, /message requires `Authorization: Bearer <token>` (or ?token=). */
  token?: string;
  /** Durable store (Phase 2). Omit → in-memory (Phase 1 dev behavior). */
  store?: Store;
  /** Resolves a per-session host (Phase 4 microVM). Omit → Supervisor defaults
   *  to a LocalHost via StaticHostProvider. */
  hostProvider?: HostProvider;
  /** Working dir inside a microVM host (default /vercel/sandbox). Ignored on local. */
  remoteCwd?: string;
  /** Alternate runner (e.g. the exempt interactive engine, BRO-1488). Omit →
   *  the default print engine (`runAgent`, `claude -p`). */
  run?: (opts: RunOptions) => Promise<RunResult>;
  /** Live-session control surface (interactive engine) → enables POST /control
   *  (reset/interrupt/status). Omit → those report "unsupported" (BRO-1493). */
  control?: EngineControl;
  /** Engine REGISTRY (BRO-1620) — per-thread engine selection. `runners` maps an
   *  engine id to its runner; `controls` the ids with a live-session control;
   *  `defaultEngine` is what a thread inherits absent a client request. `print`
   *  is always registered. Forwarded verbatim to the Supervisor. */
  runners?: Record<string, (opts: RunOptions) => Promise<RunResult>>;
  controls?: Record<string, EngineControl>;
  defaultEngine?: string;
  /** Run the agent directly in the workspace (no per-session worktree) —
   *  required for workspaces with nested git repos (BRO-1512). */
  noWorktree?: boolean;
  /** Additional selectable workspaces beyond the default (BRO-1627) — the
   *  boot-discovered registry (GENESIS_PROJECTS_ROOT scan + GENESIS_WORKSPACES
   *  override). Forwarded to the Supervisor; surfaced via GET /workspaces. */
  workspaces?: Workspace[];
  /** Per-event observability trace (print-engine parity, BRO-1524). */
  trace?: (sessionId: string, event: AgentEvent) => void;
}

export function build(opts: BuildOpts) {
  const hub = new Hub();
  const supervisor = new Supervisor({
    defaultWorkspace: { id: "ws-default", name: "genesis", rootPath: opts.workspaceRoot },
    workspaces: opts.workspaces,
    hostProvider: opts.hostProvider,
    extraArgs: opts.extraArgs,
    remoteCwd: opts.remoteCwd,
    noWorktree: opts.noWorktree,
    trace: opts.trace,
    store: opts.store,
    run: opts.run,
    control: opts.control,
    runners: opts.runners,
    controls: opts.controls,
    defaultEngine: opts.defaultEngine,
  });

  if (opts.extraArgs?.includes("--dangerously-skip-permissions") && !opts.token) {
    console.warn(
      "[genesis] WARNING: agent runs with --dangerously-skip-permissions and /message is unauthenticated. " +
        "Bind to localhost only, or set GENESIS_TOKEN. (Phase 2 wires Better Auth.)",
    );
  }

  const app = new Hono();

  // Shared bearer gate — guards every endpoint that exposes session data when a
  // token is configured ( /message AND /threads — the latter leaks history too ).
  const unauthorized = (c: {
    req: { header: (k: string) => string | undefined; query: (k: string) => string | undefined };
  }): boolean => {
    if (!opts.token) return false;
    const auth = c.req.header("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : c.req.query("token");
    return bearer !== opts.token;
  };

  app.get("/", (c) => c.html(PAGE));
  // /health doubles as the capability surface (BRO-1621): `engines` is the set
  // the box can actually run, so a client can gate its engine picker instead of
  // offering one that would silently bind the default (BRO-1622 consumes this).
  app.get("/health", (c) =>
    c.json({
      ok: true,
      workspace: opts.workspaceRoot,
      engines: supervisor.engines,
      defaultEngine: supervisor.defaultEngineId,
      // NOTE (BRO-1627 P20 M1): the workspace LIST is deliberately NOT here —
      // /health is unauthenticated, and the list carries absolute rootPaths (a
      // filesystem-layout recon aid). The list lives behind the bearer gate on
      // GET /workspaces; /health stays a liveness probe (engine-capability only).
    }),
  );

  // Thread session control (BRO-1493): reset (fresh context) / interrupt /
  // status. Slash commands map here, never into the agent TUI.
  app.post("/control", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      threadId?: string;
      action?: string;
      title?: string;
    };
    const threadId = body.threadId;
    if (!threadId) return c.json({ error: "threadId required" }, 400);
    switch (body.action) {
      case "reset":
        return c.json(await supervisor.reset(threadId));
      case "interrupt":
        return c.json(await supervisor.interrupt(threadId));
      case "status":
        return c.json(await supervisor.status(threadId));
      // Session management (BRO-1592) — archive/rename ride /control so the
      // existing /api/control BFF forwards them verbatim (no new BFF family).
      case "archive":
        return c.json(await supervisor.archiveThread(threadId, true));
      case "unarchive":
        return c.json(await supervisor.archiveThread(threadId, false));
      case "rename":
        // Validate at the boundary — body is only type-cast, so a non-string
        // title (e.g. {title: 1}) would otherwise reach setTitle().trim() and throw.
        if (typeof body.title !== "string") return c.json({ error: "title must be a string" }, 400);
        return c.json(await supervisor.setTitle(threadId, body.title));
      default:
        return c.json({ error: `unknown action: ${body.action ?? "(none)"}` }, 400);
    }
  });

  // Thread LIST for the PWA drawer (BRO-1567). Same bearer gate as the rest —
  // it exposes thread metadata + last-turn previews. (Hono matches the static
  // `/threads` ahead of the `/threads/:id` param route regardless of order, so
  // the two never collide.)
  app.get("/threads", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ threads: await supervisor.listThreads() });
  });

  // Selectable workspaces (BRO-1627) for the per-thread workspace picker. Same
  // bearer gate; the client offers these as the "which repo does this thread run
  // in" choice (bound sticky on the thread's first turn).
  app.get("/workspaces", (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    return c.json({
      workspaces: supervisor.listWorkspaces(),
      defaultWorkspace: supervisor.defaultWorkspaceId,
    });
  });

  app.get("/threads/:id", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ turns: await supervisor.history(c.req.param("id")) });
  });

  // Hard-delete a thread + its transcript (BRO-1592). First DELETE route; the
  // BFF /api/threads/:id grows a matching DELETE handler. Same bearer gate.
  app.delete("/threads/:id", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    return c.json(await supervisor.deleteThread(c.req.param("id")));
  });

  app.post("/message", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { threadId?: string; text?: string };
    const threadId = body.threadId ?? "local";
    const text = body.text ?? "";
    if (!text.trim()) return c.json({ error: "empty message" }, 400);

    hub.publish(threadId, { kind: "turn", role: "user", text });
    const result = await supervisor.dispatch(threadId, text, (state, event) => {
      hub.publish(threadId, {
        kind: "state",
        phase: state.phase,
        lastText: state.lastText,
        event: event.type,
      });
    });
    hub.publish(threadId, { kind: "turn", role: "agent", text: result.reply, phase: result.phase });
    return c.json({
      reply: result.reply,
      phase: result.phase,
      sessionId: result.session.agentSessionId,
    });
  });

  // Chat SDK channel — speaks the AI SDK UI message stream protocol, so any
  // `useChat`/`DefaultChatTransport` client (or curl) drives Genesis directly.
  // The Hono server IS the channel; no separate frontend.
  const chat = new ChatSdkConnector(() => ({
    messageId: crypto.randomUUID(),
    newTextId: () => crypto.randomUUID(),
    newReasoningId: () => crypto.randomUUID(),
  }));
  app.post("/api/chat", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    let incoming: IncomingMessage;
    try {
      incoming = chat.parseIncoming(await c.req.json().catch(() => null));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "bad request" }, 400);
    }
    const events = eventStream(async (emit) => {
      // Tool parts are emitted on transition only (BRO-1607): once when issued
      // (input-available), once when the result fills (output-available/error).
      // Keyed by toolCallId → last-emitted state, so each transition fires once.
      const emittedTool = new Map<string, string>();
      const result = await supervisor.dispatch(
        incoming.threadId,
        incoming.text,
        (state) => {
          // reasoning note rides the phase events; the connector emits it once as
          // AI-SDK reasoning parts before the answer text (BRO-1574). The prose is
          // redacted under subscription auth, so this is a token-based indicator.
          emit({
            kind: "phase",
            phase: state.phase,
            text: state.lastText,
            reasoning: reasoningNote(state.reasoned, state.thinkingTokens, state.reasoning),
          });
          // Surface new/advanced tool parts as dynamic-tool stream parts (BRO-1607)
          // — the connector closes the open text part first, so tools render in
          // place between the text blocks that bracket them.
          for (const p of state.parts ?? []) {
            if (p.type !== "tool") continue;
            if (emittedTool.get(p.toolCallId) !== p.state) {
              emittedTool.set(p.toolCallId, p.state);
              emit({ kind: "tool", part: p });
            }
          }
        },
        {
          model: incoming.model,
          effort: incoming.effort,
          engine: incoming.engine,
          workspaceId: incoming.workspaceId,
        },
      );
      emit({
        kind: "reply",
        phase: result.phase,
        text: result.reply,
        usage: result.usage,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
      });
    });
    return chat.encodeStream(events);
  });

  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      const threadId = c.req.query("thread") ?? "local";
      let unsub: () => void = () => {};
      return {
        onOpen(_e, ws) {
          unsub = hub.subscribe(threadId, (msg) => ws.send(JSON.stringify(msg)));
          ws.send(JSON.stringify({ kind: "ready", threadId }));
        },
        onClose() {
          unsub();
        },
        onError() {
          unsub(); // disconnect without a clean close must still reclaim (F17)
        },
      };
    }),
  );

  return { app, websocket, supervisor, hub };
}
