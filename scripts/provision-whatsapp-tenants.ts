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
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseAllowlist, tenantWorkspaceId } from "../apps/chat-bot/src/allowlist";
import { TenantStore } from "../apps/chat-bot/src/tenant-store";
import {
  type TenantRecord,
  egressDomainsFor,
  policyOf,
  webFetchRulesFor,
} from "../apps/chat-bot/src/tenants";
import { STACK_AGENTS, seedAgentStack } from "../packages/core/src/agent-stack";
import { seedSkills } from "../packages/core/src/skill-seed";
import { denyRulesFor } from "./tenant-deny-rules";
import {
  assertCredentialed,
  assertHomeOutsideTenant,
  assertNoStrandedAgentState,
} from "./tenant-home";

const dryRun = process.argv.includes("--dry-run");

const HOME = process.env.GENESIS_TENANT_HOME ?? "/home/agent";
const RUNTIME_ROOT =
  process.env.GENESIS_WHATSAPP_RUNTIME_ROOT ?? join(HOME, "orchestrator-workspaces");
const PREFIX = process.env.GENESIS_WHATSAPP_WORKSPACE_PREFIX?.trim() || "ws-wa-";
const WORKSPACES_DIR =
  process.env.GENESIS_WORKSPACES_DIR ?? join(HOME, ".config/genesis-bot/workspaces");
// OUTSIDE the tenant workspace, deliberately — the workspace is group-writable by
// the tenant, so a home under it would let the tenant author its own user-scope
// settings and sit beside its own credential. `assertHomeOutsideTenant` enforces it.
const TENANT_HOMES_DIR =
  process.env.GENESIS_TENANT_HOMES_DIR ?? join(HOME, ".config/genesis-bot/tenant-homes");
const RAW_ALLOWLIST = process.env.GENESIS_WHATSAPP_ALLOWED_USERS;

// BRO-2235 — per-tenant HOME. OPT-IN, and deliberately not on by default: pointing
// a tenant at its own HOME also points it at its own CREDENTIAL, and which credential
// a tenant should use (the operator's subscription vs a per-tenant API key) is an
// open operator decision. Enabling this without answering that question breaks every
// turn for that tenant.
//
// Measured, not assumed — `claude -p` under an unprovisioned HOME:
//     "Not logged in · Please run /login"   and it EXITS 0.
// A provisioning gap is therefore invisible to any exit-code check, which is why the
// refusal lives HERE, in the provisioner, where refusing is safe. The runtime
// (`tenantEnv`) stays fail-SAFE and never removes a working HOME — an outage caused
// by our own strictness would be worse than the leak it prevents.
const PER_HOME = process.env.GENESIS_TENANT_PER_HOME === "1";

/** The tenant's own HOME, or undefined when the feature is off.
 *  Kept beside the manifest so "what the tenant runs as" is one expression. */
function homeFor(id: string): string | undefined {
  return PER_HOME ? join(TENANT_HOMES_DIR, id) : undefined;
}

// The gid the agent runs as — it gets GROUP write on its tenant dir, never ownership.
const AGENT_GID = Number(process.env.GENESIS_TENANT_GID ?? 1000);

// The registry is the source of truth when configured; the env allowlist is
// the pre-BRO-2230 fallback. Reading the wrong one would provision workspaces
// for people the bot does not serve while the real tenants stay unprovisioned —
// and the bot's startup check would then refuse to serve WhatsApp at all.
const TENANTS_DIR = process.env.GENESIS_WHATSAPP_TENANTS_DIR?.trim();
// Skills installed into every tenant workspace, root-owned. Read by THIS process
// (root), never by a tenant, so one directory updates every tenant's stack.
const TENANT_SKILLS_DIR = process.env.GENESIS_TENANT_SKILLS_DIR?.trim();
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

// Carry the whole RECORD, not just the principal. `policy` and `domains` live
// on the record and decide what the settings file grants, so projecting down to
// {channel,id} here would silently provision every tenant at the default tier —
// the same shape of loss as BRO-2236, one layer up.
const registryRecords = TENANTS_DIR ? new TenantStore(TENANTS_DIR).active() : undefined;
if (registryRecords) {
  console.log(`provisioning from the tenant registry at ${TENANTS_DIR}`);
}
/** The env-allowlist fallback has no registry record, so it gets a synthetic one
 *  at the DEFAULT tier. Never a widened one: a path that cannot express a policy
 *  must not invent a generous one. */
function syntheticRecord(id: string): TenantRecord {
  return { id, channel: "kapso", state: "active", requestedAt: new Date(0).toISOString() };
}
const tenants = (
  registryRecords ??
  allowlist.principals.filter((p) => p.channel === "kapso").map((p) => syntheticRecord(p.id))
).map((record) => ({
  record,
  principal: { channel: "kapso" as const, id: record.id },
  workspaceId: tenantWorkspaceId({ channel: "kapso", id: record.id }, PREFIX),
  dir: join(RUNTIME_ROOT, record.id),
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
function settingsFor(dir: string, tenant: TenantRecord): string {
  const domains = egressDomainsFor(tenant);
  const policy = policyOf(tenant);
  return `${JSON.stringify(
    {
      permissions: {
        // Per-tenant tier. `confined` keeps every tool not named in `allow`
        // unavailable; `trusted` ungates them.
        //
        // Under `claude -p` there is NO prompt, so in `confined` an un-allowed
        // tool does not ask -- it simply fails, and the agent (which cannot see
        // why) tells the user to approve at a prompt that will never render.
        // That dead end is what `trusted` exists to remove, and it is why the
        // tier is a permission dial ONLY: the sandbox below is unchanged by it,
        // so a trusted tenant is ungated inside the same cage, never outside it.
        // `acceptEdits`, NOT `bypassPermissions` (BRO-2245 x BRO-2236).
        //
        // The tier is described as "a permission dial only... ungated inside the
        // same cage, never outside it". `bypassPermissions` does not honour that:
        // this file's own comment above says Read/Write/Edit/Glob/Grep run
        // IN-PROCESS and are not covered by `sandbox.filesystem`, so for those tools
        // the permission mode IS the cage. Bypass auto-approves every call except
        // explicit deny rules, and the deny list is a blocklist -- anything unnamed
        // is permitted.
        //
        // `acceptEdits` is the dial the tier actually wanted: it removes the
        // per-edit prompt, which is the friction a trusted tenant is being spared,
        // while deny rules and the gating of non-edit tools both stay in force.
        //
        // Revert to "bypassPermissions" if the tier is meant to be an escape hatch
        // rather than a dial -- but then say so in tenants.ts, because the current
        // wording promises a cage that bypass does not leave standing.
        defaultMode: policy === "trusted" ? "acceptEdits" : "default",
        // This file used to say "Search, not fetch: grant WebFetch only with a
        // domain allow-list, and only for a reason." BRO-2245 is the reason and
        // this is that allow-list. The objection it recorded still stands and is
        // NOT solved -- a URL is an exfiltration channel in itself, and an
        // allowlist bounds where data may go, never what may go there. What
        // makes it acceptable is the confinement underneath: a tenant reaches
        // only its own directory, so the worst it can send anywhere is its own
        // data. Under the old blocklist -- crm/, *.env and the gh token
        // readable -- any egress at all would have been an exfiltration path.
        // WebSearch plus a `WebFetch(domain:)` rule per approved domain. The
        // in-process fetch tool and the Bash sandbox are SEPARATE egress paths:
        // opening `sandbox.network` does nothing for WebFetch, and this list
        // does nothing for curl. Both are driven from the same approved set so
        // they cannot drift into "the agent can fetch it but not curl it".
        //
        // Emitted even at the `trusted` tier, where allow rules are inert, so
        // that flipping a tenant back to `confined` does not silently revoke
        // domains an operator already said yes to.
        allow: ["WebSearch", ...webFetchRulesFor(tenant)],
        // Deny rules block in EVERY mode, so these survive a future operator
        // flipping the mode back. Absolute `//` anchor: a single leading slash
        // would anchor at the settings file instead and match nothing.
        deny: [
          // Built BY CONSTRUCTION from HOME and a verb list, not written out by
          // hand. Two defects motivated that, both found on this list:
          //
          // 1. HARDCODED HOME. `HOME` above is `GENESIS_TENANT_HOME ?? "/home/agent"`,
          //    but every rule below used to spell `/home/agent` literally. The
          //    sandbox denyRead IS derived from HOME, so pointing GENESIS_TENANT_HOME
          //    anywhere else left the two layers guarding different directories --
          //    and for Read/Glob/Grep this list is the WHOLE boundary.
          //
          // 2. READ/GREP ASYMMETRY. `.ssh`, `.aws`, `.config`, `.claude` and `*.env`
          //    were denied for Read and NOT for Grep, while broomva/ and genesis/ were
          //    denied for both. Grep returns matching CONTENT, so it is a read
          //    primitive; a hand-maintained parallel list drifts the moment someone
          //    adds a path to one column. Glob is included too: it does not return
          //    content, but it enumerates what is there to ask for next.
          //
          // The cross-product cannot drift, which is the whole point.
          ...denyRulesFor(HOME, dir),
          // The sandbox denyRead below covers Bash. It does NOT cover the
          // built-in file tools, which run inside the Claude Code process --
          // so for Read/Glob/Grep, THIS list is the whole boundary, and it
          // named none of the things actually worth protecting.
          //
          // What stood in for a rule was an emergent property: "an out-of-cwd
          // read fails closed under `claude -p`". That is not uniform on this
          // box. Out-of-cwd Read has succeeded here twice, under a
          // configuration that no longer exists to inspect. An emergent
          // behaviour nobody configured is not a control, and the eval had
          // eleven Bash cases and zero file-tool cases, so nothing would have
          // caught it changing.
          //
          // Still a blocklist, with the weakness this file already names two
          // comments down: anything unnamed stays readable. These are the
          // named-and-known ones. A sibling tenant cannot be denied by prefix
          // without denying the tenant's own directory, so that gap stays open
          // for the file-tool channel and is measured by the eval instead.
          // CONFLICT RESOLVED TOWARD main's HARDENING (BRO-2245 x BRO-2236).
          //
          // This PR narrowed the tenant's `.claude/**` write-deny to just
          // settings.json + settings.local.json so a tenant could author a skill.
          // The justification was that `skills/`, `agents/` and `commands/` are
          // "prompt-level content". That is not true for two of the three:
          // `allowed-tools:` frontmatter is installed by the CLI as an
          // `allowed_tools` PERMISSION LAYER, and `.claude/agents/*.md` carries
          // `permissionMode` and `tools`. A command file can grant tool permissions
          // that inline text cannot -- at the DEFAULT confined tier, no `trusted`
          // needed.
          //
          // I did NOT carve out `.claude/skills/**` to preserve the feature, even
          // though that is the obvious compromise. I could not verify that skill
          // frontmatter cannot also carry tool permissions, and carving out a path
          // on an unverified premise about frontmatter is precisely the move that
          // produced this defect. Re-narrowing needs evidence, not symmetry.
          //
          // The tenant-authored-skill capability therefore needs a different
          // mechanism: skills installed BY THE PROVISIONER (root-owned, like the
          // settings files), or a skills directory outside `.claude/`. Revert this
          // hunk to restore the previous behaviour if that trade is wanted.
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
        // Egress allowlist (BRO-2245). With no `network` key at all the
        // resolver falls through to deny, which is why `curl`, `npx skills
        // add`, `bun install` and `git clone` were ALL blocked, DNS included --
        // and why the visible symptom was a WebFetch permission message that
        // had nothing to do with the actual cause.
        //
        // Match order in the client is deniedDomains -> allowedDomains -> deny.
        // Nothing is listed as denied here: a deny entry would be dead weight
        // against an allowlist this short, and pretending otherwise would make
        // the file look like it defends against something it does not.
        network: { allowedDomains: domains },
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
      // BRO-2235: omitted entirely when the feature is off, so the manifest a
      // tenant runs under today is byte-identical to before.
      ...(homeFor(t.principal.id) ? { home: homeFor(t.principal.id) } : {}),
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
  // BRO-2235. Create the tenant's HOME first, then REFUSE if it holds no
  // credential — before the manifest that would point a live tenant at it is
  // written. Ordering is the whole point: writing the manifest first and checking
  // after would leave a tenant configured to use a home that cannot answer.
  const tenantHome = homeFor(t.principal.id);
  if (tenantHome) {
    // Location FIRST: the other two guards are meaningless if the tenant can
    // rewrite what they validate.
    assertHomeOutsideTenant(tenantHome, t.dir);
    mkdirSync(join(tenantHome, ".claude", "projects"), { recursive: true });
    // root:agent 0750 — the agent must READ its credential, and must never be able
    // to replace the settings that confine it.
    chownSync(tenantHome, 0, AGENT_GID);
    execFileSync("/bin/chmod", ["750", tenantHome]);
    assertCredentialed(tenantHome);
    assertNoStrandedAgentState(HOME, tenantHome, t.dir);
  }
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

  // Seed the bstack agent stack (BRO-2252). Until now `.claude/agents` was
  // created EMPTY, purely so bubblewrap could bind its read-only placeholder,
  // and every tenant session started with only the default agent set.
  //
  // root:root 0444, inside the sticky 1775 directory above: the tenant can still
  // author its OWN agents (that is what BRO-2245 opened `agents/` and `skills/`
  // for) but cannot rewrite the operator's. This is a durability property, not a
  // security boundary — an agent file is prompt-level content and can only
  // narrow within what settings.json already allows. The two files that DO gate
  // capability are denied and root-owned separately, below.
  //
  // Non-clobbering by default: a re-provision must not silently delete a tenant
  // agent that happens to share a name. A shadowing name is reported instead.
  const seeded = seedAgentStack(t.dir, {
    ownership: { uid: 0, gid: 0, mode: 0o444 },
  });
  // Skills, installed the same way and for the same reason. BRO-2245 wanted a tenant
  // to hold a skill and got there by making `.claude/` tenant-writable, which is a
  // permission escalation because `allowed-tools:` frontmatter is a real permission
  // layer. Seeding root-owned 0444 gives the tenant the skill and nobody the layer.
  // Optional: unset GENESIS_TENANT_SKILLS_DIR simply seeds none.
  const skills = TENANT_SKILLS_DIR
    ? seedSkills(t.dir, {
        sourceDir: TENANT_SKILLS_DIR,
        ownership: { uid: 0, gid: 0, mode: 0o444 },
      })
    : undefined;
  if (skills) {
    for (const path of skills.skipped) {
      console.log(`  skill not replaced (differs from source): ${path}`);
    }
    console.log(`  skills: ${skills.written.length} written, ${skills.unchanged.length} unchanged`);
  }
  for (const path of seeded.skipped) {
    console.warn(
      `    SHADOWED ${path} — a tenant-authored agent holds this name; the stack version was NOT written. Re-run with the file removed to restore it.`,
    );
  }

  writeFileSync(settingsPath, settingsFor(t.dir, t.record));

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
    continue;
  }
  // The stack landed, and landed root-owned (BRO-2252). Checking existence alone
  // would pass on a tenant-authored file of the same name that shadowed it — the
  // exact case the seeder refuses to overwrite and reports. This is a WARNING,
  // not a `bad++`: a missing agent file degrades a session, it does not
  // un-confine one, and failing the whole provision over prompt-level content
  // would block a security re-provision on a cosmetic problem.
  for (const agent of STACK_AGENTS) {
    const agentPath = join(t.dir, ".claude/agents", `${agent.name}.md`);
    if (!existsSync(agentPath)) {
      console.warn(`  MISSING-AGENT ${agentPath} — sessions start without \`${agent.name}\`.`);
      continue;
    }
    const ast = statSync(agentPath);
    if (ast.uid !== 0 || (ast.mode & 0o222) !== 0) {
      console.warn(
        `  TENANT-OWNED-AGENT ${agentPath} (uid=${ast.uid}, mode=${(ast.mode & 0o777).toString(8)}) — this is the tenant's own file, not the seeded stack.`,
      );
    }
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
