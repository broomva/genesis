/** Parse the webhook port, strictly.
 *
 *  `Number(process.env.X ?? 8788)` has two holes and both end the same way — Bun
 *  binds a RANDOM EPHEMERAL PORT rather than throwing (measured on bun 1.3.14, this
 *  repo's pinned runtime: `{port: NaN}` came up on :50022, `{port: 0}` on :50023):
 *
 *   - a set-but-EMPTY var (`GENESIS_BOT_WEBHOOK_PORT=` in a sourced env file, or
 *     systemd `Environment="GENESIS_BOT_WEBHOOK_PORT="`) is `""`, which is not
 *     nullish, so `??` does not apply and `Number("")` is 0. This is the reachable
 *     one — it needs no typo, just an env line someone left blank.
 *   - a typo such as "8788x" is NaN.
 *
 *  The process then stays healthy while every inbound WhatsApp delivery is refused
 *  at the proxy, and the old log printed the REQUESTED value, so it announced
 *  "listening on 127.0.0.1:0" and looked fine.
 *
 *  Returns undefined for anything that is not a plain integer in range. Pure +
 *  exported so the invariant is covered by a test rather than by a comment. */
export function webhookPort(raw: string | undefined): number | undefined {
  if (raw === undefined) return 8788; // genuinely unset -> the documented default
  const t = raw.trim();
  if (t.length === 0) return undefined; // set-but-empty is a MISTAKE, not "use the default"
  if (!/^\d+$/.test(t)) return undefined; // "8788x", "-1", "80.5", "0x1f"
  const n = Number(t);
  // 0 means "pick any free port", which is never what an operator configuring a
  // fixed webhook endpoint behind a proxy intends.
  return n >= 1 && n <= 65535 ? n : undefined;
}
