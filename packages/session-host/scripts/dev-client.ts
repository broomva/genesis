// dev-client — the scratch multi-turn client: spawn one wrapped session in the
// current directory and drive it from this terminal, watching the IR stream
// live. Permission requests surface as cards you answer with y/n.
//
//   bun scripts/dev-client.ts [--pin 2.1.173] [--cwd /path/to/repo]

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { IREvent } from "../src/ir";
import { SessionHub } from "../src/session";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const pin = flag("--pin") ?? "2.1.173";
const cwd = flag("--cwd") ?? process.cwd();

const sockDir = await mkdtemp(join(tmpdir(), "gen-dev-"));
const hub = new SessionHub({ socketPath: join(sockDir, "control.sock") });
hub.start();

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const color = (c: number, s: string) => `\x1b[3${c}m${s}\x1b[0m`;

hub.onEvent((e: IREvent) => {
  switch (e.kind) {
    case "session.lifecycle":
      console.log(dim(`· session ${e.phase}${e.transcriptPath ? ` (${e.transcriptPath})` : ""}`));
      break;
    case "thinking":
      console.log(color(5, `🤔 ${e.text.split("\n")[0]?.slice(0, 100) ?? ""}`));
      break;
    case "message.assistant":
      console.log(color(6, e.text));
      break;
    case "tool.use":
      console.log(color(3, `⚙ ${e.name} ${JSON.stringify(e.input).slice(0, 120)}`));
      break;
    case "tool.result":
      console.log(dim(`  ↳ ${String(e.content).split("\n")[0]?.slice(0, 120) ?? ""}`));
      break;
    case "permission.request":
      console.log(bold(color(1, `🔐 PERMISSION [${e.requestId}] ${e.toolName}`)));
      console.log(color(1, `   ${JSON.stringify(e.toolInput).slice(0, 200)}`));
      console.log(color(1, `   answer: y ${e.requestId} | n ${e.requestId}`));
      break;
    case "permission.resolved":
      console.log(dim(`· permission ${e.requestId} → ${e.decision} (${e.source})`));
      break;
    case "turn.complete":
      console.log(bold(color(2, "✓ turn complete")));
      break;
    case "status":
      console.log(
        dim(`· ${e.model ?? "?"} · ctx ${e.contextUsedPct ?? "?"}% · $${e.costUsd ?? "?"}`),
      );
      break;
    case "awaiting":
      console.log(color(3, `… awaiting ${e.what}${e.message ? `: ${e.message}` : ""}`));
      break;
    case "unknown":
      console.log(dim(`· unknown(${e.surface}) ${e.tag}`));
      break;
    default:
      console.log(dim(`· ${e.kind}`));
  }
});

console.log(bold(`genesis dev-client — pin ${pin}, cwd ${cwd}`));
const session = await hub.createSession({ cwd, pin });
console.log(
  dim("type a prompt and press Enter · y/n <request-id> answers a permission · /quit exits"),
);

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
rl.prompt();
rl.on("line", (line) => {
  const text = line.trim();
  const permission = text.match(/^([yn])\s+(\S+)$/);
  if (text === "/quit") {
    void (async () => {
      await session.kill();
      await hub.stop();
      process.exit(0);
    })();
    return;
  }
  if (permission?.[1] !== undefined && permission[2] !== undefined) {
    const ok = hub.respondPermission(
      permission[2],
      permission[1] === "y" ? "allow" : "deny",
      "dev-client",
    );
    if (!ok) console.log(dim("no such pending request"));
  } else if (text.length > 0) {
    void session.send(text);
  }
  rl.prompt();
});
