import { build } from "./server";

const workspaceRoot = process.env.GENESIS_WORKSPACE ?? process.cwd();
const port = Number(process.env.PORT ?? 8787);
const { app, websocket } = build({
  workspaceRoot,
  extraArgs: process.env.GENESIS_AGENT_ARGS?.split(" ").filter(Boolean),
});

console.log(`[genesis] local channel → http://localhost:${port}  (workspace: ${workspaceRoot})`);
export default { port, fetch: app.fetch, websocket };
