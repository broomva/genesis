import { type Store, Supervisor } from "@genesis/core";
import type { HostProvider } from "@genesis/host";
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
}

export function build(opts: BuildOpts) {
  const hub = new Hub();
  const supervisor = new Supervisor({
    defaultWorkspace: { id: "ws-default", name: "genesis", rootPath: opts.workspaceRoot },
    hostProvider: opts.hostProvider,
    extraArgs: opts.extraArgs,
    remoteCwd: opts.remoteCwd,
    store: opts.store,
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
    textId: crypto.randomUUID(),
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
