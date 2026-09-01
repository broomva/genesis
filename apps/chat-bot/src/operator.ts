// Operator commands over the channel itself (BRO-2245).
//
// The allowlist grows one domain at a time, so the approval has to be as cheap
// as the request. Making the operator open an SSH session to say yes is what
// turns "ask me and I'll allow it" into "the tenant gives up".
//
// WHAT THIS DOES AND DOES NOT DO. It writes the REGISTRY, and nothing else.
// Applying a registry change means rewriting root-owned tenant settings, which
// needs root -- and on this box `agent` holds NOPASSWD:ALL, so a chat message
// that shelled out to sudo would be a remote root-execution path whose only
// gate is the principal check below. That check is exactly the kind that has
// been wrong here before (the allowlist read part 1 of the thread id, our own
// number, identical on every message, instead of part 2). So the decision
// happens over WhatsApp and the apply stays a command the operator runs.

import { normalizePhoneId } from "@genesis/identity";
import { type Principal, principalOf } from "./allowlist";
import type { TenantStore } from "./tenant-store";
import {
  BASE_EGRESS_DOMAINS,
  TENANT_POLICIES,
  TenantDomainError,
  type TenantPolicy,
  type TenantRecord,
  allowDomain,
  approve,
  denyDomain,
  egressDomainsFor,
  policyOf,
  setPolicy,
  suspend,
} from "./tenants";

/** The command an operator message asks for. Parsing is separate from applying
 *  so the gate can be tested without a store and the effects without a parser. */
export type OperatorCommand =
  | { kind: "list" }
  | { kind: "allow"; id: string; domain: string }
  | { kind: "revoke"; id: string; domain: string }
  | { kind: "policy"; id: string; policy: TenantPolicy }
  | { kind: "approve"; id: string }
  | { kind: "suspend"; id: string }
  | { kind: "help" };

/** Tokens that are operator-only. Kept separate from CONTROL_ALIASES so a
 *  tenant typing `/allow` gets the ordinary "unknown command → forward to the
 *  agent" path and learns nothing about this surface existing. */
const OPERATOR_TOKENS = new Set([
  "tenants",
  "allow",
  "revoke",
  "policy",
  "tapprove",
  "tsuspend",
  "ophelp",
]);

export function isOperatorToken(token: string): boolean {
  return OPERATOR_TOKENS.has(token.toLowerCase());
}

/** Is this thread the operator's?
 *
 *  FAILS CLOSED in every direction that matters: an unset env var means NOBODY
 *  is the operator, never everybody; an unresolvable thread id is not the
 *  operator; and the comparison is against the decoded PRINCIPAL (the sender's
 *  waId), never against raw thread text, which would match our own phone number
 *  on every inbound message. */
export function isOperator(threadId: string, operatorEnv: string | undefined): boolean {
  // Compared against `principal.id`, which comes from the same rule via
  // allowlist.ts's canonical() — an undocumented third pair that had to agree.
  const configured = normalizePhoneId(operatorEnv ?? "");
  if (configured.length === 0) return false;
  const principal: Principal | undefined = principalOf(threadId, "kapso");
  if (principal === undefined || principal.channel !== "kapso") return false;
  return principal.id === configured;
}

/** Digits-only, so an operator can paste `+57 301 775 8620` or `573017758620`. */
const normalizeId = normalizePhoneId;

export function parseOperatorCommand(
  token: string,
  args: string,
): OperatorCommand | { error: string } | undefined {
  const t = token.toLowerCase();
  if (!OPERATOR_TOKENS.has(t)) return undefined;
  const parts = args.split(/\s+/).filter((p) => p.length > 0);

  switch (t) {
    case "ophelp":
      return { kind: "help" };
    case "tenants":
      return { kind: "list" };
    // The LAST token is the value; everything before it is the number. Splitting
    // on whitespace and taking parts[0] as the id looked right and was not: an
    // operator pasting `+57 321 499 4114 docs.python.org` -- the spelling a
    // phone contact card gives you -- parsed as tenant "57", domain "321". It
    // failed closed (no such tenant) but reported a nonsense pair back, and the
    // same shape with two tokens would have approved a real domain for the
    // wrong person.
    case "allow":
    case "revoke": {
      const value = parts.at(-1);
      const id = normalizeId(parts.slice(0, -1).join(""));
      if (parts.length < 2 || !value || id.length === 0) {
        return { error: `usage: /${t} <number> <domain>` };
      }
      return { kind: t === "allow" ? "allow" : "revoke", id, domain: value };
    }
    case "policy": {
      const value = parts.at(-1);
      const id = normalizeId(parts.slice(0, -1).join(""));
      if (
        parts.length < 2 ||
        id.length === 0 ||
        !value ||
        !TENANT_POLICIES.includes(value as TenantPolicy)
      ) {
        return { error: `usage: /policy <number> <${TENANT_POLICIES.join("|")}>` };
      }
      return { kind: "policy", id, policy: value as TenantPolicy };
    }
    case "tapprove":
    case "tsuspend": {
      const id = normalizeId(parts.join(""));
      if (id.length === 0) return { error: `usage: /${t} <number>` };
      return { kind: t === "tapprove" ? "approve" : "suspend", id };
    }
    default:
      return undefined;
  }
}

/** The command the operator must run to make a registry change take effect.
 *  `sudo -E bun` does NOT work: sudo resets PATH under secure_path and bun is
 *  not on root's, so it dies AFTER the operator has already said yes. */
export const APPLY_COMMAND =
  'cd ~/genesis && sudo -E "$(command -v bun)" scripts/provision-whatsapp-tenants.ts';

export interface OperatorResult {
  readonly reply: string;
  /** True when the registry changed and tenant settings are now stale. */
  readonly needsApply: boolean;
}

function describe(t: TenantRecord): string {
  const extra = t.domains?.length ? ` +${t.domains.length}` : "";
  return `${t.id} · ${t.state} · ${policyOf(t)}${extra}`;
}

/** Apply an operator command to the registry. Pure with respect to everything
 *  except `store`, so the reply text is testable without a filesystem. */
export function applyOperatorCommand(
  cmd: OperatorCommand,
  store: Pick<TenantStore, "get" | "put" | "list">,
  now: string,
): OperatorResult {
  if (cmd.kind === "help") {
    return {
      needsApply: false,
      reply: `*Operator commands*\n\`/tenants\` — list everyone and their tier\n\`/allow <number> <domain>\` — approve a domain\n\`/revoke <number> <domain>\` — take one back\n\`/policy <number> confined|trusted\` — permission tier\n\`/tapprove <number>\` · \`/tsuspend <number>\`\n\nAlways reachable by everyone: ${BASE_EGRESS_DOMAINS.join(", ")}`,
    };
  }

  if (cmd.kind === "list") {
    const rows = store.list();
    return {
      needsApply: false,
      reply: rows.length === 0 ? "No tenants yet." : rows.map(describe).join("\n"),
    };
  }

  const existing = store.get(cmd.id);
  if (!existing) {
    // Never invent a record: approving a number that never asked would
    // provision a workspace nobody requested, and a typo would create a tenant
    // rather than failing.
    return {
      needsApply: false,
      reply: `No tenant ${cmd.id} — they must message this number first.`,
    };
  }

  let next: TenantRecord;
  try {
    switch (cmd.kind) {
      case "allow":
        next = allowDomain(existing, cmd.domain, now);
        break;
      case "revoke":
        next = denyDomain(existing, cmd.domain);
        break;
      case "policy":
        next = setPolicy(existing, cmd.policy);
        break;
      case "approve":
        next = approve(existing, now);
        break;
      case "suspend":
        next = suspend(existing, now);
        break;
    }
  } catch (e) {
    // A rejected domain changes nothing and says why. It is never "cleaned up"
    // into something that parses: the value that reaches a settings file has to
    // be the value the operator agreed to.
    return {
      needsApply: false,
      reply: e instanceof TenantDomainError ? `❌ ${e.message}` : `❌ ${String(e)}`,
    };
  }

  if (next === existing) {
    return { needsApply: false, reply: `No change — ${describe(existing)}` };
  }
  store.put(next);

  const detail =
    cmd.kind === "allow" || cmd.kind === "revoke"
      ? `\n\nNow reachable:\n${egressDomainsFor(next).join("\n")}`
      : "";
  return {
    needsApply: true,
    reply: `✅ ${describe(next)}${detail}\n\nApply it:\n\`${APPLY_COMMAND}\``,
  };
}
