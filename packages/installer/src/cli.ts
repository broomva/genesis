#!/usr/bin/env bun
// Genesis local-bot installer CLI (BRO-1534). Cross-platform (macOS launchd /
// Linux systemd --user), local-bot mode (the agent runs `claude` on THIS machine
// via the owner's subscription; owner-allowlisted Telegram). Pure rendering +
// config logic lives in ./lib; this file does the I/O.
//
//   bun run genesis install     # interactive (or pass --token/--owner/...)
//   bun run genesis status|start|stop|logs|uninstall

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type InstallInputs,
  type OS,
  detectOS,
  looksLikeToken,
  parseArgs,
  parseGetMe,
  paths,
  renderEnvSh,
  renderLaunchdPlist,
  renderSecretsEnv,
  renderStartScript,
  renderSystemdUnit,
  serviceId,
} from "./lib";

const SVCS = ["api", "bot"] as const;
type Svc = (typeof SVCS)[number];

// ─────────────────────────── small I/O helpers ───────────────────────────

async function sh(
  cmd: string[],
  opts: { quiet?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (!opts.quiet && code !== 0 && stderr.trim()) console.error(`  ! ${cmd[0]}: ${stderr.trim()}`);
  return { code, stdout, stderr };
}

/** Resolve a binary to its absolute path, or undefined if not on PATH. */
async function which(bin: string): Promise<string | undefined> {
  const r = await sh(["bash", "-lc", `command -v ${bin}`], { quiet: true });
  const path = r.stdout.trim();
  return r.code === 0 && path ? path : undefined;
}

function ask(question: string, fallback?: string): string {
  const suffix = fallback ? ` [${fallback}]` : "";
  const ans = (prompt(`${question}${suffix}:`) ?? "").trim();
  return ans || fallback || "";
}

function die(msg: string): never {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

/** The genesis repo root (cli.ts lives at <root>/packages/installer/src/cli.ts). */
function repoRoot(): string {
  // fileURLToPath decodes percent-encoding — a repo path with spaces (e.g.
  // "/Users/me/my repo") would otherwise stay "%20"-encoded and never resolve.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  if (!existsSync(join(root, "apps/api/src/index.ts"))) {
    die(`could not locate the genesis repo root (looked at ${root})`);
  }
  return root;
}

// ─────────────────────────── service backends ───────────────────────────

function launchdPlistPath(home: string, svc: Svc): string {
  return `${home}/Library/LaunchAgents/${serviceId("macos", svc)}.plist`;
}
function systemdUnitPath(home: string, svc: Svc): string {
  return `${home}/.config/systemd/user/${serviceId("linux", svc)}`;
}

async function registerService(os: OS, home: string, svc: Svc, unitBody: string): Promise<void> {
  if (os === "macos") {
    const path = launchdPlistPath(home, svc);
    writeFileSync(path, unitBody);
    const uid = process.getuid?.() ?? 0;
    await sh(["launchctl", "bootout", `gui/${uid}/${serviceId("macos", svc)}`], { quiet: true });
    const r = await sh(["launchctl", "bootstrap", `gui/${uid}`, path]);
    if (r.code !== 0) die(`launchctl bootstrap failed for ${svc}`);
  } else {
    const path = systemdUnitPath(home, svc);
    writeFileSync(path, unitBody);
    await sh(["systemctl", "--user", "daemon-reload"]);
    const r = await sh(["systemctl", "--user", "enable", "--now", serviceId("linux", svc)]);
    if (r.code !== 0) die(`systemctl enable failed for ${svc}`);
    // `enable --now` starts a stopped unit but does NOT restart a running one, so
    // a RE-install would keep the stale env. Force a restart to pick up new config.
    const rr = await sh(["systemctl", "--user", "restart", serviceId("linux", svc)]);
    if (rr.code !== 0) die(`systemctl restart failed for ${svc} (config may be stale)`);
  }
}

/** Returns false when a control action's service-manager call failed (so the CLI
 *  can exit non-zero — important for scripts). status/logs are informational →
 *  always true. */
async function serviceAction(
  os: OS,
  svc: Svc,
  action: "start" | "stop" | "status" | "logs",
): Promise<boolean> {
  const home = homedir();
  if (os === "macos") {
    const uid = process.getuid?.() ?? 0;
    const target = `gui/${uid}/${serviceId("macos", svc)}`;
    if (action === "start") return (await sh(["launchctl", "kickstart", "-k", target])).code === 0;
    if (action === "stop") return (await sh(["launchctl", "bootout", target])).code === 0;
    if (action === "status") {
      const r = await sh(["launchctl", "print", target], { quiet: true });
      const line = r.stdout.split("\n").find((l) => l.includes("state =")) ?? "(not loaded)";
      console.log(`  ${svc}: ${line.trim()}`);
      return true;
    }
    const log = `${paths(os, home).logDir}/genesis-${svc}.log`;
    const r = await sh(["tail", "-n", "40", log], { quiet: true });
    console.log(`── ${svc} (${log}) ──\n${r.stdout}`);
    return true;
  }
  const unit = serviceId("linux", svc);
  if (action === "logs") {
    const r = await sh(["journalctl", "--user", "-u", unit, "-n", "40", "--no-pager"], {
      quiet: true,
    });
    console.log(`── ${svc} (${unit}) ──\n${r.stdout}`);
    return true;
  }
  if (action === "status") {
    const r = await sh(["systemctl", "--user", "status", unit], { quiet: true });
    const line = r.stdout.split("\n").find((l) => l.includes("Active:")) ?? "(unknown)";
    console.log(`  ${svc}: ${line.trim()}`);
    return true;
  }
  // start | stop — propagate the systemctl exit code.
  return (await sh(["systemctl", "--user", action, unit])).code === 0;
}

// ─────────────────────────── commands ───────────────────────────

async function cmdInstall(flags: Record<string, string>): Promise<void> {
  const os = detectOS();
  const home = homedir();
  const root = repoRoot();
  const p = paths(os, home);
  console.log(`\nGenesis local-bot installer — ${os}\n`);

  // 1. Prereqs.
  const bun = await which("bun");
  if (!bun) die("bun not found on PATH — install bun first (https://bun.sh)");
  const claude = await which("claude");
  if (!claude) {
    die("claude CLI not found — install it and run `claude` once to log in (subscription auth)");
  }
  const git = await which("git");
  const tmux = await which("tmux"); // only needed for the interactive engine
  console.log(`  bun    ${bun}`);
  console.log(`  claude ${claude}  (must be logged in: run \`claude\` once if unsure)`);
  if (!tmux) console.log("  tmux   (absent — fine for the default print engine)");

  // 2. Inputs (flags → env → prompt).
  let botToken = flags.token ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!looksLikeToken(botToken)) botToken = ask("Telegram bot token (from @BotFather)");
  if (!looksLikeToken(botToken))
    die("that doesn't look like a Telegram bot token (<digits>:<chars>)");

  // 3. Validate token via getMe.
  const me = await fetch(`https://api.telegram.org/bot${botToken}/getMe`)
    .then((r) => r.json())
    .catch(() => null);
  const parsed = parseGetMe(me);
  if (!parsed.ok) die(`Telegram rejected the token: ${parsed.reason}`);
  const botUsername = parsed.username ?? "unknown";
  console.log(`  bot    @${botUsername} ✓`);

  const allowedUsers = flags.owner ?? ask("Your Telegram numeric chat id (owner allowlist)");
  if (!/^\d+(,\d+)*$/.test(allowedUsers)) {
    die("owner chat id must be numeric (DM @userinfobot to get yours). REQUIRED — no open bots.");
  }
  // No silent fallback: the workspace is the agent's blast radius (it runs with
  // --dangerously-skip-permissions). Require it explicitly — never default to $HOME.
  const wsInput = (flags.workspace ?? ask("Workspace dir the agent may read/write")).trim();
  if (!wsInput) die("workspace is required (the dir the agent operates on). Pass --workspace.");
  const workspace = resolve(wsInput.startsWith("~") ? wsInput.replace(/^~/, home) : wsInput);
  if (!existsSync(workspace)) die(`workspace ${workspace} does not exist`);
  const port = Number(flags.port ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) die(`invalid port ${flags.port}`);

  // 4. PATH dirs the service needs (dirs of the resolved tools).
  const pathDirs = [
    ...new Set([bun, claude, git, tmux].filter((x): x is string => !!x).map((b) => dirname(b))),
  ];

  const inputs: InstallInputs = {
    os,
    home,
    repoDir: root,
    botToken,
    botUsername,
    allowedUsers,
    workspace,
    port,
    pathDirs,
  };

  // 5. Write config (secrets 0600, env, start scripts +x).
  for (const d of [p.configDir, p.dataDir, p.stateDir, p.logDir]) mkdirSync(d, { recursive: true });
  writeFileSync(p.secretsFile, renderSecretsEnv(botToken), { mode: 0o600 });
  chmodSync(p.secretsFile, 0o600); // enforce even if the file pre-existed
  writeFileSync(p.envFile, renderEnvSh(inputs, p));
  writeFileSync(p.apiStart, renderStartScript(inputs, p, "api"));
  writeFileSync(p.botStart, renderStartScript(inputs, p, "bot"));
  chmodSync(p.apiStart, 0o755);
  chmodSync(p.botStart, 0o755);
  console.log(`  config ${p.configDir} (secrets.env 0600)`);

  // 6. Register + start the service.
  if (os === "linux") {
    mkdirSync(`${home}/.config/systemd/user`, { recursive: true });
    // userInfo() is reliable; process.env.USER can be unset/mismatched. Linger is
    // best-effort (it may need polkit auth) — warn loudly rather than abort.
    const user = userInfo().username;
    const lr = await sh(["loginctl", "enable-linger", user], { quiet: true });
    if (lr.code !== 0) {
      console.warn(
        `  ⚠ couldn't enable linger for ${user} — the service won't survive logout. Run: sudo loginctl enable-linger ${user}`,
      );
    }
  }
  for (const svc of SVCS) {
    const unit =
      os === "macos" ? renderLaunchdPlist(inputs, p, svc) : renderSystemdUnit(inputs, p, svc);
    await registerService(os, home, svc, unit);
  }
  console.log(`  service registered + started (${os === "macos" ? "launchd" : "systemd --user"})`);

  // 7. Verify /health.
  const ok = await waitForHealth(port, 15);
  console.log("  manage: genesis status | logs | stop | start | uninstall");
  if (!ok) {
    // The service is registered but not answering — exit non-zero so a scripted
    // install detects the failure (the service keeps retrying in the background).
    die(
      `:${port}/health didn't answer in 15s. The service is registered but unhealthy — run \`genesis logs\` (a busy port or a logged-out \`claude\` are the usual causes).`,
    );
  }
  console.log(
    `\n✓ Genesis is running on :${port}. DM @${botUsername} from chat id ${allowedUsers}.`,
  );
}

async function waitForHealth(port: number, tries: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/health`);
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await Bun.sleep(1000);
  }
  return false;
}

async function cmdUninstall(): Promise<void> {
  const os = detectOS();
  const home = homedir();
  let removed = true;
  for (const svc of SVCS) {
    // The bootout/disable exit code is intentionally tolerated: uninstall is
    // idempotent, and an already-stopped/not-loaded service returns non-zero
    // there without being a real failure. What MUST hold is that the unit file
    // is gone — that's the failure we propagate.
    if (os === "macos") {
      const uid = process.getuid?.() ?? 0;
      await sh(["launchctl", "bootout", `gui/${uid}/${serviceId("macos", svc)}`], { quiet: true });
      const path = launchdPlistPath(home, svc);
      if (existsSync(path)) {
        try {
          rmSync(path);
        } catch {
          removed = false;
        }
      }
    } else {
      await sh(["systemctl", "--user", "disable", "--now", serviceId("linux", svc)], {
        quiet: true,
      });
      const path = systemdUnitPath(home, svc);
      if (existsSync(path)) {
        try {
          rmSync(path);
        } catch {
          removed = false;
        }
      }
    }
  }
  if (!removed) die("could not remove a service unit file — check permissions.");
  console.log(
    "✓ service removed. Config + secrets kept under ~/.config/genesis-bot (rm to purge).",
  );
}

async function cmdEach(action: "start" | "stop" | "status" | "logs"): Promise<void> {
  const os = detectOS();
  let ok = true;
  for (const svc of SVCS) ok = (await serviceAction(os, svc, action)) && ok;
  // start/stop are operations a script depends on — fail loudly. status/logs are
  // informational and never fail the CLI.
  if (!ok && (action === "start" || action === "stop")) {
    die(`one or more services failed to ${action}.`);
  }
}

function usage(): void {
  console.log(`genesis — local-bot service manager (macOS launchd / Linux systemd)

  install     interactive setup + register + start (flags: --token --owner --workspace --port)
  status      show service state
  start|stop  control both services
  logs        recent logs
  uninstall   remove the service (keeps config)`);
}

const { command, flags } = parseArgs(Bun.argv.slice(2));
switch (command) {
  case "install":
    await cmdInstall(flags);
    break;
  case "status":
  case "start":
  case "stop":
  case "logs":
    await cmdEach(command);
    break;
  case "uninstall":
    await cmdUninstall();
    break;
  default:
    usage();
}
