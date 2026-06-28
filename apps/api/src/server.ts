import { type AgentEvent, type EngineControl, type Store, Supervisor } from "@genesis/core";
import type { HostProvider } from "@genesis/host";
import type { RunOptions, RunResult } from "@genesis/runner";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { eventStream } from "./channel/bridge";
import { ChatSdkConnector } from "./channel/chat-sdk";
import { Hub } from "./hub";
import { PAGE } from "./ui";

const { upgradeWebSocket, websocket } = createBunWebSocket();

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
  /** Run the agent directly in the workspace (no per-session worktree) —
   *  required for workspaces with nested git repos (BRO-1512). */
  noWorktree?: boolean;
  /** Per-event observability trace (print-engine parity, BRO-1524). */
  trace?: (sessionId: string, event: AgentEvent) => void;
}

export function build(opts: BuildOpts) {
  const hub = new Hub();
  const supervisor = new Supervisor({
    defaultWorkspace: { id: "ws-default", name: "genesis", rootPath: opts.workspaceRoot },
    hostProvider: opts.hostProvider,
    extraArgs: opts.extraArgs,
    remoteCwd: opts.remoteCwd,
    noWorktree: opts.noWorktree,
    trace: opts.trace,
    store: opts.store,
    run: opts.run,
    control: opts.control,
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
  app.get("/health", (c) => c.json({ ok: true, workspace: opts.workspaceRoot }));

  // Thread session control (BRO-1493): reset (fresh context) / interrupt /
  // status. Slash commands map here, never into the agent TUI.
  app.post("/control", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      threadId?: string;
      action?: string;
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

  app.get("/threads/:id", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ turns: await supervisor.history(c.req.param("id")) });
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
  }));
  app.post("/api/chat", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    let incoming: { threadId: string; text: string };
    try {
      incoming = chat.parseIncoming(await c.req.json().catch(() => null));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "bad request" }, 400);
    }
    const events = eventStream(async (emit) => {
      const result = await supervisor.dispatch(incoming.threadId, incoming.text, (state) => {
        emit({ kind: "phase", phase: state.phase, text: state.lastText });
      });
      emit({ kind: "reply", phase: result.phase, text: result.reply });
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
