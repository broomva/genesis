#!/usr/bin/env bun
import { type Store, Supervisor } from "@genesis/core";
import { createPgliteStore, createPostgresStore } from "@genesis/db";
import { LocalHost } from "@genesis/host";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error('usage: bun src/cli.ts "<prompt>"');
  process.exit(2);
}
const workspaceRoot = process.env.GENESIS_WORKSPACE ?? process.cwd();
const extraArgs = process.env.GENESIS_AGENT_ARGS?.split(" ").filter(Boolean);

// Durable by default so a CLI thread resumes across invocations (FS-as-truth).
const url = process.env.DATABASE_URL;
const store: Store = url
  ? await createPostgresStore(url)
  : await createPgliteStore(process.env.GENESIS_DATA_DIR ?? `${process.env.HOME}/.genesis/data`);

const sup = new Supervisor({
  defaultWorkspace: { id: "ws-cli", name: "cli", rootPath: workspaceRoot },
  host: new LocalHost(),
  extraArgs,
  store,
});

process.stderr.write(`[genesis] dispatching to ${workspaceRoot}\n`);
const r = await sup.dispatch("cli", prompt, (s) => process.stderr.write(`  · ${s.phase}\n`));
process.stderr.write(`[genesis] phase=${r.phase} session=${r.session.agentSessionId ?? "-"}\n`);
console.log(r.reply);
