#!/usr/bin/env bun
import { Supervisor } from "@genesis/core";
import { LocalHost } from "@genesis/host";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error('usage: bun src/cli.ts "<prompt>"');
  process.exit(2);
}
const workspaceRoot = process.env.GENESIS_WORKSPACE ?? process.cwd();
const extraArgs = process.env.GENESIS_AGENT_ARGS?.split(" ").filter(Boolean);

const sup = new Supervisor({
  defaultWorkspace: { id: "ws-cli", name: "cli", rootPath: workspaceRoot },
  host: new LocalHost(),
  extraArgs,
});

process.stderr.write(`[genesis] dispatching to ${workspaceRoot}\n`);
const r = await sup.dispatch("cli", prompt, (s) => process.stderr.write(`  · ${s.phase}\n`));
process.stderr.write(`[genesis] phase=${r.phase} session=${r.session.agentSessionId ?? "-"}\n`);
console.log(r.reply);
