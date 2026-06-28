// BFF proxy → genesis `GET /threads` (thread list for the PWA drawer, BRO-1567).
//
// Same auth gate as /api/chat (BRO-1564): a human session OR the machine
// X-Agent-Token, else 401 with no upstream call. The list exposes thread
// metadata + last-turn previews, so it must never be reachable unauthenticated.

import { authorizePrincipal } from "@/lib/api-auth";
import { proxyGenesisGetJson } from "@/lib/genesis-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const principal = await authorizePrincipal(req);
  if (!principal.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (principal.asAgent) console.info("[bff] /api/threads authorized as machine principal (agent)");
  return proxyGenesisGetJson("/threads", req);
}
