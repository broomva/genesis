// Personal-WhatsApp principal resolution (linked-device channel).
//
// Unlike Kapso (Cloud API, business number), this channel drives a PERSONAL
// account by registering as a linked device — the same companion slot
// WhatsApp Web/Desktop occupies. Baileys hands us raw WhatsApp JIDs rather
// than the `kapso:<b64url>:<b64url>` thread ids, so the principal grammar is
// different and must not reuse Kapso's parser.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS: WhatsApp has TWO identity namespaces.
//
//   <digits>@s.whatsapp.net   phone-number JID  ("PN")
//   <digits>@lid              linked identifier ("LID")
//
// Both are BARE DIGITS before the '@', and a LID's digits are NOT a phone
// number. Baileys carries a whole mapping subsystem for this
// (`Signal/lid-mapping.js`, `getPNForLID` / `getLIDForPN`, the
// `lid-mapping.update` event), because the same human reaches you under either
// namespace depending on how the chat was established.
//
// The existing Kapso canonicalization is digits-only (`normalizePhone`, which
// strips every non-digit). Applying it here would map
//
//     573001234567@s.whatsapp.net  -> "573001234567"
//     573001234567@lid             -> "573001234567"     // COLLIDES
//
// i.e. an arbitrary LID whose digits happen to equal an allowlisted phone
// number would be authorized to drive an auto-allow agent. So the namespace is
// part of the canonical form here, never stripped. Cross-namespace resolution
// is possible (Baileys' `getPNForLID` does a USYNC round-trip) but it is async,
// network-dependent, and fails open on error — so this module keeps the two
// namespaces DISJOINT and requires the operator to list whichever form they
// actually receive. Denying a real user is recoverable; authorizing an unknown
// one is not.
//
// This is the same failure shape as the Kapso `phoneNumberId`-vs-`waId` bug
// (see allowlist.ts): the harmless-looking failure (my allowlist does nothing)
// invites the dangerous fix (GENESIS_ALLOW_OPEN=1).

/** WhatsApp's two user identity namespaces. Never merged. */
export type WaNamespace = "pn" | "lid";

/** A resolved personal-WhatsApp actor. `id` is digits; `ns` says which
 *  namespace those digits live in. The pair is the identity — never `id` alone. */
export interface WaPrincipal {
  readonly ns: WaNamespace;
  readonly id: string;
}

/** Canonical string form, namespace-tagged so PN and LID cannot collide. */
export function formatWaPrincipal(p: WaPrincipal): string {
  return `${p.ns}:${p.id}`;
}

/**
 * Resolve a Baileys JID to a principal, or undefined when it is not a user JID
 * we are willing to authorize.
 *
 * Handles, per Baileys `WABinary/jid-utils.js`:
 *  - device suffixes   `1234:7@s.whatsapp.net` -> device stripped
 *  - agent suffixes    `1234_1@s.whatsapp.net` -> agent stripped
 *  - the legacy server `1234@c.us`             -> treated as `s.whatsapp.net`
 *
 * Deliberately DENIED (returns undefined):
 *  - groups `@g.us`, broadcast `@broadcast`, newsletters `@newsletter`
 *    Group messages are out of scope for this channel, and a group JID is not
 *    a person — authorizing one would authorize every member.
 *  - `@hosted` / `@hosted.lid` — hosted-identity semantics are not pinned down
 *    in the Baileys source (its own jid-utils carries a `todo:` for them), and
 *    an identity we cannot explain is one we cannot authorize.
 */
export function waJidPrincipal(jid: string | undefined | null): WaPrincipal | undefined {
  if (typeof jid !== "string") return undefined;
  const trimmed = jid.trim();
  const sep = trimmed.indexOf("@");
  if (sep <= 0) return undefined; // no '@', or empty user part

  const server = trimmed.slice(sep + 1).toLowerCase();
  const userCombined = trimmed.slice(0, sep);

  let ns: WaNamespace;
  if (server === "s.whatsapp.net" || server === "c.us") ns = "pn";
  else if (server === "lid") ns = "lid";
  else return undefined; // groups, broadcast, newsletter, hosted*, anything else

  // Strip device (`:N`) then agent (`_N`), mirroring jidDecode's split order.
  const withoutDevice = userCombined.split(":")[0] ?? "";
  const user = withoutDevice.split("_")[0] ?? "";

  // A user part must be all digits. Anything else is a JID shape we do not
  // model, and an unmodelled identity is denied rather than guessed.
  if (user.length === 0 || !/^\d+$/.test(user)) return undefined;

  return { ns, id: user };
}

/**
 * True when `remoteJid` addresses the linked account's own chat ("Note to
 * Self") — the default write surface for this channel.
 *
 * Compared namespace-aware and device-insensitive: the account's own id
 * arrives with a device suffix on some stanzas (`me.id` is typically
 * `<pn>:<device>@s.whatsapp.net`) and bare on others.
 */
export function isSelfChat(remoteJid: string | undefined | null, meJid: string | undefined | null): boolean {
  const remote = waJidPrincipal(remoteJid);
  const me = waJidPrincipal(meJid);
  if (remote === undefined || me === undefined) return false;
  return remote.ns === me.ns && remote.id === me.id;
}
