// Owner allowlist (BRO-1512) — gate which threads the bot will serve.
//
// The interactive engine auto-allows ALL tools + bash. When the workspace is a
// real directory (e.g. ~/broomva or the VPS orchestrator workspace) rather than
// a throwaway sandbox, an unauthenticated bot would let ANY user drive an
// auto-allow agent on that machine (RCE-by-DM). The allowlist restricts
// processing to known principals.
//
// FAIL-CLOSED (BRO-1534): an UNSET allowlist would serve everyone. The bot
// REFUSES TO START with no allowlist unless `GENESIS_ALLOW_OPEN=1` explicitly
// acknowledges an open/throwaway-sandbox posture.
//
// ---------------------------------------------------------------------------
// MULTI-CHANNEL (BRO-2216) — two changes, both load-bearing.
//
// 1. Thread ids are NOT uniformly `<channel>:<id>`. Telegram's are, but Kapso
//    (WhatsApp) encodes as
//        kapso:<b64url(phoneNumberId)>:<b64url(waId)>[:<b64url(conversationId)>]
//    (verified against @kapso/chat-adapter@0.1.1 dist/index.js `encodeThreadId`).
//    The old "slice after the first colon" rule yields a base64 blob for Kapso,
//    so an operator-written phone number could NEVER match. That fails closed —
//    every WhatsApp message silently dropped — but the natural debugging move is
//    to set GENESIS_ALLOW_OPEN=1, which serves EVERY WhatsApp sender. The
//    dangerous state is reached by fixing the harmless one, so the decoder is a
//    security control, not a convenience.
//
// 2. A bare (unprefixed) entry now binds to ONE channel — the env var it came
//    from — instead of matching on every channel. With a single channel that
//    distinction was invisible; with two, an entry meant as a Telegram chat id
//    would also authorize a WhatsApp sender whose number happened to collide.
//
// Env:
//   GENESIS_TELEGRAM_ALLOWED_USERS  bare entries bind to telegram ("547052379")
//   GENESIS_WHATSAPP_ALLOWED_USERS  bare entries bind to kapso, compared
//                                   digits-only so "+57 300 123 4567",
//                                   "573001234567" and "+573001234567" are one
//                                   principal
// Either accepts fully-qualified entries ("telegram:547052379", "kapso:5730..."),
// which bind to the named channel regardless of which var they appear in.

export type ChannelId = "telegram" | "kapso";

/** A resolved actor: the channel it spoke on, and its id on that channel. */
import { normalizePhoneId } from "@genesis/identity";

export interface Principal {
  readonly channel: ChannelId;
  readonly id: string;
}

// One implementation, in @genesis/identity — this was one of four copies (BRO-2422).
const normalizePhone = normalizePhoneId;

/** Channel-appropriate canonical form for comparison. */
function canonical(channel: ChannelId, id: string): string {
  return channel === "kapso" ? normalizePhone(id) : id.trim();
}

/** base64url -> utf8, or undefined when `value` is not canonical base64url.
 *  Node's decoder is lenient (it silently accepts junk and yields mojibake), so
 *  the round-trip re-encode is what makes this a validation and not a guess. */
function decodePart(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (decoded.length === 0) return undefined;
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

/** The principal a thread id speaks as, or undefined if it cannot be resolved.
 *
 *  Unresolvable is DENIED, never allowed: a thread id we cannot parse is a
 *  thread id we cannot authorize. `fallback` is the channel a bare, prefix-less
 *  id is attributed to (the allowlist's own channel — a bare thread id can only
 *  reach a channel that was configured). */
export function principalOf(threadId: string, fallback: ChannelId): Principal | undefined {
  const trimmed = threadId.trim();
  if (trimmed.length === 0) return undefined;

  if (trimmed.startsWith("kapso:")) {
    // kapso:<phoneNumberId>:<waId>[:<conversationId>] — all base64url.
    // The SENDER is waId (part 2); phoneNumberId is OUR number, identical for
    // every inbound message, so matching on it would authorize the world.
    const parts = trimmed.split(":");
    if (parts.length !== 3 && parts.length !== 4) return undefined;
    const waId = decodePart(parts[2] ?? "");
    if (waId === undefined) return undefined;
    const id = normalizePhone(waId);
    return id.length === 0 ? undefined : { channel: "kapso", id };
  }

  if (trimmed.startsWith("telegram:")) {
    const id = trimmed.slice("telegram:".length).trim();
    return id.length === 0 ? undefined : { channel: "telegram", id };
  }

  if (trimmed.includes(":")) return undefined; // a channel we do not know -> deny
  return { channel: fallback, id: canonical(fallback, trimmed) };
}

/** The principal an OPERATOR-WRITTEN allowlist entry names.
 *
 *  Entries and thread ids are DIFFERENT grammars and must not share a parser:
 *  a human writes `kapso:+57 300 123 4567`, while the adapter emits
 *  `kapso:<b64url>:<b64url>`. Parsing one with the other's rules silently drops
 *  the entry — which fails closed, but presents as "my allowlist does nothing",
 *  the same trap that leads an operator to GENESIS_ALLOW_OPEN=1.
 *
 *  A pasted real thread id is still accepted: the thread-id grammar is tried
 *  first, so both spellings of the same principal work. */
export function entryPrincipal(entry: string, channel: ChannelId): Principal | undefined {
  const asThreadId = principalOf(entry, channel);
  if (asThreadId !== undefined) return asThreadId;

  const trimmed = entry.trim();
  const sep = trimmed.indexOf(":");
  if (sep === -1) return undefined; // bare handled by principalOf above

  const named = trimmed.slice(0, sep).toLowerCase();
  const rest = trimmed.slice(sep + 1).trim();
  if (rest.length === 0) return undefined;
  if (named !== "telegram" && named !== "kapso") return undefined;

  const id = canonical(named, rest);
  return id.length === 0 ? undefined : { channel: named, id };
}

/** Why a thread was refused. The distinction is the point: "not-listed" is the
 *  control working, "unresolvable" is the control unable to evaluate — and
 *  collapsing them into one silent denial is what makes a misconfigured gate
 *  look like a dead bot, which is what sends an operator to GENESIS_ALLOW_OPEN=1.
 *  Callers log the reason so a false denial is diagnosable without disabling
 *  anything. Both still DENY. */
export type Decision =
  | { allowed: true }
  | { allowed: false; reason: "not-listed" | "unresolvable" };

export interface Allowlist {
  /** True when no allowlist is configured (allow-all, sandbox posture). */
  readonly open: boolean;
  /** Whether a given thread id is permitted. */
  allows(threadId: string): boolean;
  /** As `allows`, but says why on refusal. */
  decide(threadId: string): Decision;
  /** Every principal this list authorizes, deduped, in config order.
   *
   *  ALWAYS EMPTY when `open` — an open list authorizes everyone, so its
   *  principal set is not enumerable. A caller that provisions a resource per
   *  principal (BRO-2224: one sandboxed workspace per phone number) must read
   *  empty-and-open as "cannot enumerate", NEVER as "nothing to provision":
   *  the second reading provisions zero tenants and then serves everyone from
   *  the engine default, which is the widest workspace on the box. */
  readonly principals: readonly Principal[];
}

/** Build an allowlist from raw env values (comma-separated ids).
 *
 *  `channel` is the channel bare entries bind to — and the channel a bare
 *  thread id is attributed to. Defaults to telegram so existing single-channel
 *  callers and their config keep working unchanged. */
export function parseAllowlist(
  raw: string | undefined,
  channel: ChannelId = "telegram",
): Allowlist {
  const entries = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (entries.length === 0) {
    return {
      open: true,
      allows: () => true,
      decide: () => ({ allowed: true }),
      principals: [],
    };
  }

  // Key on "<channel> <id>" so a Telegram id can never satisfy a Kapso
  // principal (or vice versa) even when the digits coincide.
  const set = new Set<string>();
  const principals: Principal[] = [];
  for (const entry of entries) {
    const p = entryPrincipal(entry, channel);
    if (p === undefined) continue;
    const key = `${p.channel} ${p.id}`;
    if (set.has(key)) continue; // same principal written twice -> provision once
    set.add(key);
    principals.push(p);
  }

  return {
    open: false,
    principals,
    decide(threadId: string): Decision {
      const p = principalOf(threadId, channel);
      if (p === undefined) return { allowed: false, reason: "unresolvable" };
      if (set.has(`${p.channel} ${p.id}`)) return { allowed: true };
      return { allowed: false, reason: "not-listed" };
    },
    allows(threadId: string): boolean {
      return this.decide(threadId).allowed;
    },
  };
}

/** Boot-time decision: serve (enforced/open) or refuse. Pure + testable so the
 *  fail-closed rule (BRO-1534) is covered, not just logged. */
export type StartupDecision =
  | { action: "serve"; allowlist: Allowlist; open: boolean }
  | { action: "refuse"; reason: string };

/** One channel the bot is about to register, and its configured allowlist. */
export interface ChannelConfig {
  readonly channel: ChannelId;
  readonly raw: string | undefined;
  /** Env var name, quoted back to the operator in the refusal. */
  readonly envVar: string;
}

/** Gate every REGISTERED channel (BRO-2216).
 *
 *  Per-channel, not global: with a global gate, configuring Telegram alone
 *  would satisfy the check while an also-registered WhatsApp number served
 *  the world. A channel is gated because it is registered — so registering a
 *  channel and forgetting its allowlist is a refusal, not an open door. */
export function startupGateFor(
  channels: readonly ChannelConfig[],
  allowOpen: boolean,
): StartupDecision {
  if (channels.length === 0) {
    return { action: "refuse", reason: "no channels registered — nothing to serve." };
  }

  const lists = channels.map((c) => ({ ...c, allowlist: parseAllowlist(c.raw, c.channel) }));
  const unguarded = lists.filter((l) => l.allowlist.open);

  if (unguarded.length > 0 && !allowOpen) {
    const names = unguarded.map((l) => l.envVar).join(", ");
    return {
      action: "refuse",
      reason: `no ${names} set — refusing to start an OPEN bot (it would serve every user on that channel = RCE-by-DM on the workspace). Set ${names}=<your id>, or GENESIS_ALLOW_OPEN=1 for a throwaway sandbox.`,
    };
  }

  const open = unguarded.length > 0;

  /** Whether `l` is entitled to speak for this thread at all.
   *
   *  The union used to be `lists.some((l) => l.allowlist.allows(threadId))`, on the
   *  reasoning that "each principal is already channel-qualified". That holds for
   *  operator-written ENTRIES and fails in two places:
   *
   *  1. An OPEN list's predicate is `() => true` — not channel-qualified at all. So
   *     registering WhatsApp without its allowlist made the ENFORCED Telegram list
   *     inert: `allows("telegram:111")` returned true from the kapso list.
   *  2. A BARE (unprefixed) thread id is attributed by `principalOf(id, fallback)` to
   *     whichever fallback the caller passes, and each list passes its own channel.
   *     So one channel's list could authorize another channel's bare thread.
   *
   *  A bare id genuinely has no channel of its own. With one channel registered that
   *  is unambiguous and still works; with several it is a guess, and guessing which
   *  channel a principal belongs to is the whole thing this module exists to prevent. */
  const multiChannel = lists.length > 1;
  const ownsThread = (l: (typeof lists)[number], threadId: string): boolean => {
    if (multiChannel && !threadId.includes(":")) return false; // ambiguous -> nobody owns it
    const p = principalOf(threadId, l.channel);
    return p !== undefined && p.channel === l.channel;
  };

  const decide = (threadId: string): Decision => {
    if (lists.some((l) => ownsThread(l, threadId) && l.allowlist.allows(threadId)))
      return { allowed: true };
    // Refused by every channel. Report "unresolvable" only when NO channel
    // could even parse the id — if one understood it and simply did not list
    // it, that is the control working and must not read as a malfunction.
    const parsedSomewhere = lists.some((l) => {
      if (!ownsThread(l, threadId)) return false; // a list that cannot speak for it did not "parse" it
      const d = l.allowlist.decide(threadId);
      return d.allowed || d.reason !== "unresolvable";
    });
    return { allowed: false, reason: parsedSomewhere ? "not-listed" : "unresolvable" };
  };
  // Union of every channel's principals. Deduped on the channel-qualified key,
  // so a Telegram id and a WhatsApp number that happen to share digits stay two
  // principals (and get two workspaces), matching how `decide` compares them.
  const seen = new Set<string>();
  const principals: Principal[] = [];
  for (const l of lists) {
    for (const p of l.allowlist.principals) {
      const key = `${p.channel} ${p.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      principals.push(p);
    }
  }

  return {
    action: "serve",
    open,
    allowlist: {
      open,
      decide,
      allows: (threadId: string) => decide(threadId).allowed,
      principals,
    },
  };
}

/** Single-channel gate (Telegram). Retained so existing callers and tests are
 *  unaffected by the multi-channel generalization. */
export function startupGate(raw: string | undefined, allowOpen: boolean): StartupDecision {
  return startupGateFor(
    [{ channel: "telegram", raw, envVar: "GENESIS_TELEGRAM_ALLOWED_USERS" }],
    allowOpen,
  );
}

/** The workspace id a principal's tenant directory is registered under
 *  (BRO-2224).
 *
 *  Lives beside the decoder on purpose. THREE callers derive this id — the
 *  dispatch path, the boot-time verification, and the provisioning script — and
 *  if any two disagree the system is silently wrong in a way nothing reports:
 *  provision directory A, verify workspace A, run every turn in workspace B.
 *  One function, importable without pulling the handler's dependencies, so a
 *  provisioning script has no excuse to re-implement phone normalization. */
export function tenantWorkspaceId(principal: Principal, prefix: string): string {
  return `${prefix}${principal.id}`;
}
