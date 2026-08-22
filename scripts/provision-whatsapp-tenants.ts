#!/usr/bin/env bun
// Provision one confined tenant workspace per allowlisted WhatsApp sender
// (BRO-2224). Run on the host that serves the channel, as root:
//
//   sudo -E bun scripts/provision-whatsapp-tenants.ts [--dry-run]
//
// Reads the SAME allowlist the bot enforces and derives ids with the SAME
// function the bot dispatches on (tenantWorkspaceId), so a sender cannot be
// provisioned into one directory and served from another. Re-implementing the
// phone normalization here is the specific mistake this import exists to
// prevent: "+57 300 123 4567" and "573001234567" are one tenant, and a second
// parser that disagreed would silently create a directory nobody runs in.
//
// Idempotent: safe to re-run after adding a principal to the allowlist.
//
// WHY .claude IS ROOT-OWNED. The tenant settings are what enable the sandbox
// and drop bypassPermissions. They sit inside the one directory the agent can
// write, project settings outrank user settings, and Claude Code applies a
// settings edit to the RUNNING session — so an agent that can rewrite them can
// switch its own sandbox off mid-turn. Ownership is the control that does not
// depend on getting a config path right; the denyWrite and Edit-deny below are
// defense in depth, not the boundary.

import { chmodSync, chownSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllowlist, tenantWorkspaceId } from "../apps/chat-bot/src/allowlist";

const dryRun = process.argv.includes("--dry-run");

const HOME = process.env.GENESIS_TENANT_HOME ?? "/home/agent";
const RUNTIME_ROOT =
  process.env.GENESIS_WHATSAPP_RUNTIME_ROOT ?? join(HOME, "orchestrator-workspaces");
const PREFIX = process.env.GENESIS_WHATSAPP_WORKSPACE_PREFIX?.trim() || "ws-wa-";
const WORKSPACES_DIR =
  process.env.GENESIS_WORKSPACES_DIR ?? join(HOME, ".config/genesis-bot/workspaces");
const RAW_ALLOWLIST = process.env.GENESIS_WHATSAPP_ALLOWED_USERS;

// The uid/gid the agent runs as — everything except .claude is handed to it.
const AGENT_UID = Number(process.env.GENESIS_TENANT_UID ?? 1000);
const AGENT_GID = Number(process.env.GENESIS_TENANT_GID ?? 1000);

const allowlist = parseAllowlist(RAW_ALLOWLIST, "kapso");

// An open allowlist authorizes senders we cannot name, so there is no finite
// set to provision. Provisioning zero tenants and exiting 0 would read as
// success while every sender fell through to the engine default workspace.
if (allowlist.open) {
  console.error(
    "GENESIS_WHATSAPP_ALLOWED_USERS is unset or empty. An open channel has no enumerable " +
      "tenant set, so nothing can be provisioned and every sender would run in the engine " +
      "default workspace. Set the allowlist and re-run.",
  );
  process.exit(1);
}

const tenants = allowlist.principals
  .filter((p) => p.channel === "kapso")
  .map((p) => ({
    principal: p,
    workspaceId: tenantWorkspaceId(p, PREFIX),
    dir: join(RUNTIME_ROOT, p.id),
  }));

if (tenants.length === 0) {
  console.error("The allowlist names no WhatsApp principal — nothing to provision.");
  process.exit(1);
}

/** The per-tenant settings. Both confinement layers key off this directory:
 *  Bash through the OS sandbox, and the built-in file tools through the
 *  permission flow (they are NOT sandboxed — verified — so dropping
 *  bypassPermissions is what confines them, since an out-of-cwd read then fails
 *  closed under `claude -p`). */
function settingsFor(dir: string): string {
  return `${JSON.stringify(
    {
      permissions: {
        // NOT bypassPermissions. Under bypass, allow rules are inert and the
        // file tools are ungated, so per-tenant confinement cannot be built.
        defaultMode: "default",
        // Deny rules block in EVERY mode, so these survive a future operator
        // flipping the mode back. Absolute `//` anchor: a single leading slash
        // would anchor at the settings file instead and match nothing.
        deny: [
          "Read(//home/agent/.ssh/**)",
          "Read(//home/agent/.aws/**)",
          "Read(//home/agent/.config/**)",
          "Read(//home/agent/.claude/**)",
          `Edit(//${dir.replace(/^\//, "")}/.claude/**)`,
          `Write(//${dir.replace(/^\//, "")}/.claude/**)`,
        ],
      },
      sandbox: {
        enabled: true,
        // Without this, a command the sandbox denies can be retried with
        // dangerouslyDisableSandbox — the agent leaving its own boundary.
        allowUnsandboxedCommands: false,
        filesystem: {
          // Deny the whole runtime root, then re-open exactly this tenant. The
          // documented overlap rule is "the more specific path wins", so a
          // sibling tenant's files stay unreadable to Bash.
          denyRead: [
            RUNTIME_ROOT,
            join(HOME, ".ssh"),
            join(HOME, ".aws"),
            join(HOME, ".config"),
            join(HOME, ".claude"),
          ],
          allowRead: [dir],
          denyWrite: [join(dir, ".claude")],
        },
      },
    },
    null,
    2,
  )}\n`;
}

/** The Genesis workspace manifest. `noWorktree` because a tenant directory is
 *  the unit of isolation itself — a worktree under it would put two senders'
 *  checkouts back in one place. */
function manifestFor(t: (typeof tenants)[number]): string {
  return `${JSON.stringify(
    { id: t.workspaceId, name: `wa-${t.principal.id}`, rootPath: t.dir, noWorktree: true },
    null,
    2,
  )}\n`;
}

console.log(
  `${dryRun ? "[dry-run] " : ""}provisioning ${tenants.length} WhatsApp tenant(s)\n` +
    `  runtime root : ${RUNTIME_ROOT}\n  workspaces   : ${WORKSPACES_DIR}\n  prefix       : ${PREFIX}\n`,
);

for (const t of tenants) {
  const claudeDir = join(t.dir, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const manifestPath = join(WORKSPACES_DIR, `${t.workspaceId}.json`);
  console.log(`  ${t.principal.id} -> ${t.dir}  (${t.workspaceId})`);
  if (dryRun) continue;

  mkdirSync(t.dir, { recursive: true });
  mkdirSync(WORKSPACES_DIR, { recursive: true });
  // The tenant owns its workspace...
  chownSync(t.dir, AGENT_UID, AGENT_GID);

  // ...but NOT the settings that confine it.
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, settingsFor(t.dir));
  chownSync(settingsPath, 0, 0);
  chmodSync(settingsPath, 0o444);
  chownSync(claudeDir, 0, 0);
  chmodSync(claudeDir, 0o555); // r-x: the agent cannot add or replace files here

  writeFileSync(manifestPath, manifestFor(t));
}

if (dryRun) {
  console.log("\n[dry-run] nothing written.");
  process.exit(0);
}

// Verify what we just claimed, rather than trusting the writes. A settings file
// the agent can still write is a sandbox it can still switch off.
let bad = 0;
for (const t of tenants) {
  const settingsPath = join(t.dir, ".claude/settings.json");
  if (!existsSync(settingsPath)) {
    console.error(`  MISSING ${settingsPath}`);
    bad++;
    continue;
  }
  const st = statSync(settingsPath);
  const mode = st.mode & 0o777;
  if (st.uid !== 0 || (mode & 0o222) !== 0) {
    console.error(
      `  WRITABLE-BY-TENANT ${settingsPath} (uid=${st.uid}, mode=${mode.toString(8)}) — the agent could disable its own sandbox. Re-run as root.`,
    );
    bad++;
  }
}
if (bad > 0) {
  console.error(`\n${bad} tenant(s) not correctly confined.`);
  process.exit(1);
}
console.log(`\nprovisioned ${tenants.length} tenant(s); restart genesis-bot to pick them up.`);
