// Owner allowlist (BRO-1512) — gate which Telegram threads the bot will serve.
//
// The interactive engine auto-allows ALL tools + bash. When the workspace is a
// real directory (e.g. ~/broomva) rather than a throwaway sandbox, an
// unauthenticated bot would let ANY Telegram user drive an auto-allow agent on
// the owner's machine (RCE-by-DM). The allowlist restricts processing to
// known thread ids (a DM thread id == the user's chat id).
//
// `GENESIS_TELEGRAM_ALLOWED_USERS`: comma-separated ids. Each entry matches
// either the bare chat id ("547052379") or the full thread id
// ("telegram:547052379").
//
// FAIL-CLOSED (BRO-1534): an UNSET allowlist would serve every Telegram user —
// RCE-by-DM on whatever workspace the agent has. So the bot REFUSES TO START
// with no allowlist unless `GENESIS_ALLOW_OPEN=1` explicitly acknowledges an
// open/throwaway-sandbox posture. The previous behavior (unset → allow-all with
// only a log line) was a fail-open security gap.

export interface Allowlist {
  /** True when no allowlist is configured (allow-all, sandbox posture). */
  readonly open: boolean;
  /** Whether a given thread id is permitted. */
  allows(threadId: string): boolean;
}

/** Build an allowlist from the raw env value (comma-separated ids). */
export function parseAllowlist(raw: string | undefined): Allowlist {
  const ids = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    return { open: true, allows: () => true };
  }
  const set = new Set(ids);
  return {
    open: false,
    allows(threadId: string): boolean {
      if (set.has(threadId)) return true;
      // Also match the bare chat id (thread ids look like "telegram:<id>").
      const bare = threadId.includes(":") ? threadId.slice(threadId.indexOf(":") + 1) : threadId;
      return set.has(bare);
    },
  };
}

/** Boot-time decision: serve (enforced/open) or refuse. Pure + testable so the
 *  fail-closed rule (BRO-1534) is covered, not just logged. */
export type StartupDecision =
  | { action: "serve"; allowlist: Allowlist; open: boolean }
  | { action: "refuse"; reason: string };

export function startupGate(raw: string | undefined, allowOpen: boolean): StartupDecision {
  const allowlist = parseAllowlist(raw);
  if (allowlist.open && !allowOpen) {
    return {
      action: "refuse",
      reason:
        "no GENESIS_TELEGRAM_ALLOWED_USERS set — refusing to start an OPEN bot " +
        "(it would serve every Telegram user = RCE-by-DM on the workspace). " +
        "Set GENESIS_TELEGRAM_ALLOWED_USERS=<your chat id>, or GENESIS_ALLOW_OPEN=1 " +
        "for a throwaway sandbox.",
    };
  }
  return { action: "serve", allowlist, open: allowlist.open };
}
