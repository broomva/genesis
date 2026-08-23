#!/usr/bin/env bun
// Tenant admin CLI (BRO-2230).
//
//   bun scripts/tenants.ts list [state]
//   bun scripts/tenants.ts approve <number> [note]
//   bun scripts/tenants.ts suspend <number> [note]
//
// Deliberately does NOT provision. Provisioning needs root (root-owned tenant
// settings the tenant cannot rewrite); this runs as the operator. Approving
// prints the provision command rather than silently doing half of it as the
// wrong user and leaving a workspace the tenant owns.

import { TenantStore } from "../apps/chat-bot/src/tenant-store";
import { approve, suspend } from "../apps/chat-bot/src/tenants";

const dir = process.env.GENESIS_WHATSAPP_TENANTS_DIR?.trim();
if (!dir) {
  console.error("GENESIS_WHATSAPP_TENANTS_DIR is not set — no registry to operate on.");
  process.exit(1);
}
const store = new TenantStore(dir);
const [cmd, arg, ...rest] = process.argv.slice(2);
const note = rest.join(" ") || undefined;
const now = new Date().toISOString();

/** Accept any spelling an operator might paste. The registry key is digits. */
const normalize = (v: string) => v.replace(/\D/g, "");

function render(): void {
  const rows = store.list().filter((t) => !arg || t.state === arg);
  if (rows.length === 0) {
    console.log(arg ? `no tenants in state "${arg}"` : "no tenants yet");
    return;
  }
  for (const t of rows) {
    const when =
      t.state === "active" ? t.approvedAt : t.state === "suspended" ? t.suspendedAt : t.requestedAt;
    console.log(
      `${t.state.padEnd(9)} ${t.id.padEnd(14)} ${(when ?? "").slice(0, 19).padEnd(20)} ${t.note ?? ""}`,
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
      console.log(
        "\nnow provision their workspace and restart:\n" +
          "  sudo -E bun scripts/provision-whatsapp-tenants.ts\n" +
          "  systemctl --user restart genesis-bot.service",
      );
    }
    break;
  }

  default:
    console.error("usage: bun scripts/tenants.ts <list|approve|suspend> [args]");
    process.exit(1);
}
