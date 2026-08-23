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

import { execFileSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllowlist, tenantWorkspaceId } from "../apps/chat-bot/src/allowlist";
import { TenantStore } from "../apps/chat-bot/src/tenant-store";

const dryRun = process.argv.includes("--dry-run");

const HOME = process.env.GENESIS_TENANT_HOME ?? "/home/agent";
const RUNTIME_ROOT =
  process.env.GENESIS_WHATSAPP_RUNTIME_ROOT ?? join(HOME, "orchestrator-workspaces");
const PREFIX = process.env.GENESIS_WHATSAPP_WORKSPACE_PREFIX?.trim() || "ws-wa-";
const WORKSPACES_DIR =
  process.env.GENESIS_WORKSPACES_DIR ?? join(HOME, ".config/genesis-bot/workspaces");
const RAW_ALLOWLIST = process.env.GENESIS_WHATSAPP_ALLOWED_USERS;

// The gid the agent runs as — it gets GROUP write on its tenant dir, never ownership.
const AGENT_GID = Number(process.env.GENESIS_TENANT_GID ?? 1000);

// The registry is the source of truth when configured; the env allowlist is
// the pre-BRO-2230 fallback. Reading the wrong one would provision workspaces
// for people the bot does not serve while the real tenants stay unprovisioned —
// and the bot's startup check would then refuse to serve WhatsApp at all.
const TENANTS_DIR = process.env.GENESIS_WHATSAPP_TENANTS_DIR?.trim();
const allowlist = parseAllowlist(RAW_ALLOWLIST, "kapso");

// An open allowlist authorizes senders we cannot name, so there is no finite
// set to provision. Provisioning zero tenants and exiting 0 would read as
// success while every sender fell through to the engine default workspace.
if (!TENANTS_DIR && allowlist.open) {
  console.error(
    "GENESIS_WHATSAPP_ALLOWED_USERS is unset or empty. An open channel has no enumerable " +
      "tenant set, so nothing can be provisioned and every sender would run in the engine " +
      "default workspace. Set the allowlist and re-run.",
  );
  process.exit(1);
}

const registryPrincipals = TENANTS_DIR
  ? new TenantStore(TENANTS_DIR).active().map((t) => ({ channel: "kapso" as const, id: t.id }))
  : undefined;
if (registryPrincipals) {
  console.log(`provisioning from the tenant registry at ${TENANTS_DIR}`);
}
const tenants = (registryPrincipals ?? allowlist.principals)
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
          // ALLOWLIST, not a blocklist. The sandbox's default read policy is
          // "the entire computer except denied directories", so enumerating
          // paths to deny leaves everything unnamed readable — which is how the
          // first version of this file let a tenant read crm/ PII, sibling
          // projects, *.env files, and the logged-in gh/railway CLI tokens.
          // Deny the home directory outright and re-open exactly this tenant;
          // the documented overlap rule is "the more specific path wins".
          //
          // Measured with a positive control (echo ran, ./inside.txt created):
          //   ls /home/agent            -> no output
          //   test -r ~/kanon.env       -> ENV-BLOCKED
          //   ls ~/broomva/crm          -> No such file or directory
          //   gh auth status            -> "not logged into any GitHub hosts"
          // The gh/railway CLI tokens are closed by this too: a CLI cannot read
          // a credential file it cannot reach.
          denyRead: [HOME],
          allowRead: [dir],
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
    {
      id: t.workspaceId,
      name: `wa-${t.principal.id}`,
      rootPath: t.dir,
      noWorktree: true,
      // Untrusted principal: the supervisor hardens the spawn (drops inherited
      // MCP). MCP runs outside the filesystem sandbox, so the settings above
      // cannot reach it — without this the tenant holds the operator's Railway,
      // Gmail, Drive and Calendar.
      confined: true,
    },
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
  // The tenant can WRITE its workspace but does not OWN it, and the sticky bit
  // is what makes that distinction bite. Unlinking a file needs write on the
  // PARENT directory, not on the file — so an agent-owned tenant dir lets the
  // agent `rm -rf .claude` and install its own settings no matter how the
  // settings file itself is owned. Measured: it renamed .claude on the first
  // attempt. The sticky bit alone does not fix it either, because a directory's
  // OWNER is exempt from it. root:agent 1775 is the combination that holds:
  // group-write to work in, not the owner, so sticky actually applies.
  chownSync(t.dir, 0, AGENT_GID);
  // NOT chmodSync: bun's fs.chmodSync masks the mode to 0o777 and SILENTLY
  // drops the sticky bit (measured on bun 1.3.14: chmodSync(dir, 0o1775) then
  // stat -> 775, while coreutils chmod 1775 -> 1775). The call reports success
  // either way, so without the stat assertion below this would have shipped as
  // a tenant directory the agent could empty. Shell out for this one bit.
  execFileSync("/bin/chmod", ["1775", t.dir]);

  // ...but NOT the two settings files that confine it.
  //
  // .claude is sticky-writable (root:agent 1775), NOT read-only. A 0555 .claude
  // breaks every turn: the sandbox bind-mounts read-only placeholders over its
  // protected paths and must CREATE them if absent, which fails inside its own
  // mount namespace ("bwrap: Can't create file at .../.claude/commands:
  // Read-only file system"). Pre-creating them is what makes strict mode usable
  // here. Sticky still denies the tenant any root-owned entry.
  mkdirSync(claudeDir, { recursive: true });
  for (const protectedPath of ["commands", "agents", "skills"]) {
    mkdirSync(join(claudeDir, protectedPath), { recursive: true });
    chownSync(join(claudeDir, protectedPath), 0, AGENT_GID);
    execFileSync("/bin/chmod", ["1775", join(claudeDir, protectedPath)]);
  }
  writeFileSync(settingsPath, settingsFor(t.dir));

  // settings.local.json is PROJECT-LOCAL settings — precedence level 3, ABOVE
  // the level-4 settings.json beside it. A tenant that can create this file can
  // override the sandbox switches in the file we just wrote. Pre-create it
  // root-owned and empty so the slot is taken and the sandbox has its
  // placeholder; sticky on .claude keeps the tenant from replacing it.
  const localPath = join(claudeDir, "settings.local.json");
  writeFileSync(localPath, "{}\n");

  for (const f of [settingsPath, localPath]) {
    chownSync(f, 0, 0);
    chmodSync(f, 0o444);
  }
  chownSync(claudeDir, 0, AGENT_GID);
  execFileSync("/bin/chmod", ["1775", claudeDir]);

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
  // The directory guard comes first: a tenant dir the agent owns makes every
  // property of the settings file below irrelevant.
  const dst = statSync(t.dir);
  const dmode = dst.mode & 0o7777;
  if (dst.uid !== 0 || (dmode & 0o1000) === 0) {
    console.error(
      `  UNPROTECTED-DIR ${t.dir} (uid=${dst.uid}, mode=${dmode.toString(8)}) — the tenant could unlink .claude and install its own settings. Expected root-owned with the sticky bit (1775).`,
    );
    bad++;
    continue;
  }
  const localPath = join(t.dir, ".claude/settings.local.json");
  if (!existsSync(localPath)) {
    console.error(
      `  MISSING ${localPath} — the tenant could create it and override the sandbox switches from a higher precedence level.`,
    );
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
console.log(`\nprovisioned ${tenants.length} tenant(s).`);

// Tell the api to re-read the registry. Without this it serves a boot-time
// snapshot, the bot asks whether the new workspace exists, is told no, and
// refuses to serve WhatsApp AT ALL — an outage for every existing tenant, per
// onboarding. Measured exactly that before this endpoint existed.
const apiUrl = (process.env.GENESIS_URL ?? "http://localhost:8787").replace(/\/$/, "");
const apiToken = process.env.GENESIS_TOKEN;
try {
  const res = await fetch(`${apiUrl}/workspaces/refresh`, {
    method: "POST",
    headers: apiToken ? { authorization: `Bearer ${apiToken}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { count?: number };
  console.log(`api registry reloaded (${body.count ?? "?"} workspaces) — no restart needed.`);
} catch (e) {
  // LOUD, not best-effort-silent: if the reload did not happen the operator must
  // restart, and a quiet failure here is exactly the state that crash-loops the
  // bot the next time it starts.
  console.error(
    `\ncould not reload the api registry at ${apiUrl} (${e instanceof Error ? e.message : e}).\nThe new tenant is NOT yet visible to the bot. Restart both, api first:\n  systemctl --user restart genesis-api.service && sleep 5\n  systemctl --user restart genesis-bot.service`,
  );
  process.exit(1);
}
