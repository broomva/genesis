import { type Store, Supervisor } from "@genesis/core";
import { LocalHost } from "@genesis/host";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
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
}

export function build(opts: BuildOpts) {
  const hub = new Hub();
  const supervisor = new Supervisor({
    defaultWorkspace: { id: "ws-default", name: "genesis", rootPath: opts.workspaceRoot },
    host: new LocalHost(),
    extraArgs: opts.extraArgs,
    store: opts.store,
  });

  if (opts.extraArgs?.includes("--dangerously-skip-permissions") && !opts.token) {
    console.warn(
      "[genesis] WARNING: agent runs with --dangerously-skip-permissions and /message is unauthenticated. " +
        "Bind to localhost only, or set GENESIS_TOKEN. (Phase 2 wires Better Auth.)",
    );
  }

  const app = new Hono();

  app.get("/", (c) => c.html(PAGE));
  app.get("/health", (c) => c.json({ ok: true, workspace: opts.workspaceRoot }));
  app.get("/threads/:id", async (c) =>
    c.json({ turns: await supervisor.history(c.req.param("id")) }),
  );

  app.post("/message", async (c) => {
    if (opts.token) {
      const auth = c.req.header("authorization");
      const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : c.req.query("token");
      if (bearer !== opts.token) return c.json({ error: "unauthorized" }, 401);
    }
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
