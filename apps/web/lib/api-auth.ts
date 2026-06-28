// Shared BFF auth gate (BRO-1564, reused by /api/chat + /api/threads* — BRO-1567).
//
// Every BFF route that proxies session data to the genesis engine authenticates
// ONE of two principals before touching the upstream:
//   • HUMAN — a valid Better Auth session (passkey). A browser fetch carries the
//     session cookie automatically; this is the primary path.
//   • AGENT — a server-only machine token in the `X-Agent-Token` header, compared
//     constant-time to AGENT_TOKEN. Lets the agent operate / dogfood without a
//     biometric. Distinct from the upstream `Authorization: Bearer GENESIS_TOKEN`
//     (server→engine), so there is no collision with the client credential.
// With NEITHER ⇒ caller returns 401, no upstream call. AGENT_TOKEN unset ⇒ the
// agent path is hard-disabled (fail closed), so it can never weaken the gate.
//
// Centralizing the gate here keeps the three routes from drifting apart — a new
// proxy route gets the exact same enforcement by calling authorizePrincipal().

import { auth } from "@/lib/auth";
import { timingSafeEqual } from "@/lib/timing-safe-equal";

// Machine-principal token. Unset ⇒ no agent path (fail closed).
const AGENT_TOKEN = process.env.AGENT_TOKEN;

// True iff a valid machine token is presented. Fail-closed: no env ⇒ false even
// for an empty header, so the agent path simply does not exist unless configured.
function agentAuthorized(req: Request): boolean {
  if (!AGENT_TOKEN) return false;
  const provided = req.headers.get("x-agent-token") ?? "";
  return provided.length > 0 && timingSafeEqual(provided, AGENT_TOKEN);
}

export type Principal = { ok: true; asAgent: boolean } | { ok: false };

/** Authorize a BFF request as a human session OR the machine agent. The session
 *  check stays primary; the agent path is only consulted when there is no
 *  session, and only when AGENT_TOKEN is configured. */
export async function authorizePrincipal(req: Request): Promise<Principal> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (session) return { ok: true, asAgent: false };
  if (agentAuthorized(req)) return { ok: true, asAgent: true };
  return { ok: false };
}
