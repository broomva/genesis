// BFF proxy → genesis `POST /control` (thread session control, BRO-1576).
//
// Drives the engine's reset / interrupt / status actions (server.ts /control)
// from the PWA's slash commands (/reset, /clear). Same auth gate as the rest
// (BRO-1564): a human session OR the machine X-Agent-Token, else 401 with no
// upstream call. The body ({ threadId, action }) is forwarded verbatim; the
// engine /control re-validates action ∈ {reset,interrupt,status} + threadId.

import { authorizePrincipal } from "@/lib/api-auth";
import { proxyGenesisPostJson } from "@/lib/genesis-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const principal = await authorizePrincipal(req);
  if (!principal.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (principal.asAgent) console.info("[bff] /api/control authorized as machine principal (agent)");

  return proxyGenesisPostJson("/control", await req.text(), req);
}
