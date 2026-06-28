import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality for comparing secrets (auth tokens, bootstrap
 * tokens). Uses Node's audited `crypto.timingSafeEqual` primitive rather than a
 * hand-rolled loop. Length is checked first — `timingSafeEqual` throws on
 * unequal-length buffers, and leaking only the length of a high-entropy secret
 * (e.g. `openssl rand -base64 32`) removes no practical entropy.
 *
 * `nodejs` runtime only (imports `node:crypto`); both auth routes that use this
 * already declare `export const runtime = "nodejs"`.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return nodeTimingSafeEqual(ab, bb);
}
