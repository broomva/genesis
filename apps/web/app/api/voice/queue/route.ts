// BFF proxy → genesis `GET /admin/voice/queue` (the voice queue panel, BRO-2284).
//
// Same auth gate as /api/threads: a human session OR the machine X-Agent-Token,
// else 401 with no upstream call. The queue carries callers' request text and
// their phone numbers, so it must never be reachable unauthenticated — which is
// also why the upstream path is not under /voice, the prefix the Tailscale Funnel
// publishes to the internet.

import { authorizePrincipal } from "@/lib/api-auth";
import { proxyGenesisGetJson } from "@/lib/genesis-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const principal = await authorizePrincipal(req);
  if (!principal.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  return proxyGenesisGetJson("/admin/voice/queue", req);
}
