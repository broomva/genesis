#!/usr/bin/env bun
// Tenant admin CLI (BRO-2230).
//
//   bun scripts/tenants.ts list [state]
//   bun scripts/tenants.ts approve <number> [note]
//   bun scripts/tenants.ts suspend <number> [note]
//   bun scripts/tenants.ts allow-domain <number> <domain>
//   bun scripts/tenants.ts deny-domain  <number> <domain>
//   bun scripts/tenants.ts policy       <number> <confined|trusted>
//
// Deliberately does NOT provision. Provisioning needs root (root-owned tenant
// settings the tenant cannot rewrite); this runs as the operator. Approving
// prints the provision command rather than silently doing half of it as the
// wrong user and leaving a workspace the tenant owns.

import { TenantStore } from "../apps/chat-bot/src/tenant-store";
import {
  BASE_EGRESS_DOMAINS,
  TENANT_POLICIES,
  TenantDomainError,
  type TenantPolicy,
  allowDomain,
  approve,
  denyDomain,
  policyOf,
  setPolicy,
  suspend,
} from "../apps/chat-bot/src/tenants";
import { normalizePhoneId } from "../packages/identity/src/index";

const dir = process.env.GENESIS_WHATSAPP_TENANTS_DIR?.trim();
if (!dir) {
  console.error("GENESIS_WHATSAPP_TENANTS_DIR is not set — no registry to operate on.");
  process.exit(1);
}
const store = new TenantStore(dir);
const [cmd, arg, ...rest] = process.argv.slice(2);
const note = rest.join(" ") || undefined;
const now = new Date().toISOString();

/** Accept any spelling an operator might paste. The registry key is digits.
 *
 *  This was a fifth copy of the rule. allowlist.ts's own comment says "a
 *  provisioning script has no excuse to re-implement phone normalization" — and
 *  this is that script, doing exactly that, two files away (BRO-2422). Relative
 *  import to match this file's existing style; scripts/ is not a workspace member. */
const normalize = normalizePhoneId;

/** `sudo -E bun` does NOT work: sudo resets PATH and bun is not on root's, so
 *  it dies with "command not found" after the operator has already approved.
 *  Resolve the interpreter in the CALLER's shell and hand sudo an absolute path. */
const PROVISION_CMD = '  sudo -E "$(command -v bun)" scripts/provision-whatsapp-tenants.ts';

/** Look a tenant up or exit. Never invents a record: approving a number that
 *  never asked would provision a workspace nobody requested, and a typo would
 *  silently create a tenant instead of failing. */
function mustGet(id: string) {
  const existing = store.get(id);
  if (!existing) {
    console.error(`no tenant ${id} in the registry — they must message the number first.`);
    process.exit(1);
  }
  return existing;
}

function render(): void {
  const rows = store.list().filter((t) => !arg || t.state === arg);
  if (rows.length === 0) {
    console.log(arg ? `no tenants in state "${arg}"` : "no tenants yet");
    return;
  }
  for (const t of rows) {
    const when =
      t.state === "active" ? t.approvedAt : t.state === "suspended" ? t.suspendedAt : t.requestedAt;
    const extra = t.domains?.length ? ` +${t.domains.length}d` : "";
    console.log(
      `${t.state.padEnd(9)} ${t.id.padEnd(14)} ${policyOf(t).padEnd(9)}${extra.padEnd(5)} ` +
        `${(when ?? "").slice(0, 19).padEnd(20)} ${t.note ?? ""}`,
    );
  }
}

switch (cmd) {
  case "list":
    render();
    break;

  case "approve":
  case "suspend": {
    if (!arg) {
      console.error(`usage: bun scripts/tenants.ts ${cmd} <number> [note]`);
      process.exit(1);
    }
    const id = normalize(arg);
    const existing = store.get(id);
    if (!existing) {
      // Refuse rather than inventing a record: approving a number that never
      // asked would provision a workspace nobody requested, and a typo would
      // silently create a tenant instead of failing.
      console.error(`no tenant ${id} in the registry — they must message the number first.`);
      process.exit(1);
    }
    const next = cmd === "approve" ? approve(existing, now, note) : suspend(existing, now, note);
    store.put(next);
    console.log(`${id}: ${existing.state} -> ${next.state}`);
    if (cmd === "approve") {
      // The provisioner reloads the api registry itself now (BRO-2230), so no
      // restart is needed on the happy path. It exits non-zero and prints the
      // restart commands if that reload fails.
      console.log(`\nnow provision their workspace:\n${PROVISION_CMD}`);
    }
    break;
  }

  case "allow-domain":
  case "deny-domain": {
    const domain = rest[0];
    if (!arg || !domain) {
      console.error(`usage: bun scripts/tenants.ts ${cmd} <number> <domain>`);
      process.exit(1);
    }
    const id = normalize(arg);
    const existing = mustGet(id);
    let next: typeof existing;
    try {
      next =
        cmd === "allow-domain" ? allowDomain(existing, domain, now) : denyDomain(existing, domain);
    } catch (e) {
      // A rejected domain exits non-zero and changes nothing. It must not be
      // "cleaned up" into something that parses: the value that lands in the
      // settings file has to be the value the operator agreed to.
      console.error(e instanceof TenantDomainError ? e.message : String(e));
      process.exit(1);
    }
    if (next === existing) {
      console.log(
        cmd === "allow-domain"
          ? `${id}: already allowed (${existing.domains?.length ?? 0} domains)`
          : `${id}: not in the list, nothing removed`,
      );
      break;
    }
    store.put(next);
    console.log(`${id}: ${(next.domains ?? []).length} approved domain(s)`);
    for (const d of next.domains ?? []) console.log(`  ${d}`);
    console.log(`\nalways available to every tenant: ${BASE_EGRESS_DOMAINS.join(", ")}`);
    console.log(`\napply it:\n${PROVISION_CMD}`);
    break;
  }

  case "policy": {
    const value = rest[0] as TenantPolicy | undefined;
    if (!arg || !value || !TENANT_POLICIES.includes(value)) {
      console.error(
        `usage: bun scripts/tenants.ts policy <number> <${TENANT_POLICIES.join("|")}>\n\n  confined  every tool not pre-allowed is unavailable (no prompt exists under -p)\n  trusted   tools ungated; the sandbox still confines files and egress`,
      );
      process.exit(1);
    }
    const id = normalize(arg);
    const existing = mustGet(id);
    const next = setPolicy(existing, value);
    store.put(next);
    console.log(`${id}: ${policyOf(existing)} -> ${value}`);
    console.log(`\napply it:\n${PROVISION_CMD}`);
    break;
  }

  default:
    console.error(
      "usage: bun scripts/tenants.ts <list|approve|suspend|allow-domain|deny-domain|policy> [args]",
    );
    process.exit(1);
}
