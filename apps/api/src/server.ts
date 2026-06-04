import { Supervisor } from "@genesis/core";
import { LocalHost } from "@genesis/host";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { Hub } from "./hub";
import { PAGE } from "./ui";

const { upgradeWebSocket, websocket } = createBunWebSocket();

export interface BuildOpts {
  workspaceRoot: string;
  extraArgs?: string[];
}

export function build(opts: BuildOpts) {
  const hub = new Hub();
  const supervisor = new Supervisor({
    defaultWorkspace: { id: "ws-default", name: "genesis", rootPath: opts.workspaceRoot },
    host: new LocalHost(),
    extraArgs: opts.extraArgs,
  });

  const app = new Hono();

  app.get("/", (c) => c.html(PAGE));
  app.get("/health", (c) => c.json({ ok: true, workspace: opts.workspaceRoot }));

  // history for a thread
  app.get("/threads/:id", (c) => c.json({ turns: supervisor.history(c.req.param("id")) }));

  // send a message → dispatch → live-stream phases over the hub → reply
  app.post("/message", async (c) => {
    const body = (await c.req.json()) as { threadId?: string; text?: string };
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

  // live session-event stream
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
      };
    }),
  );

  return { app, websocket, supervisor };
}
