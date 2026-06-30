// BFF proxy → genesis `GET /workspaces` (selectable workspaces, BRO-1627).
//
// Same auth gate as /api/threads (BRO-1564): a human session OR the machine
// X-Agent-Token, else 401 with no upstream call. The list exposes workspace ids
// + display names (rootPaths are stripped server-side), so it must never be
// reachable unauthenticated — the topology itself is sensitive.

import { authorizePrincipal } from "@/lib/api-auth";
import { proxyGenesisGetJson } from "@/lib/genesis-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const principal = await authorizePrincipal(req);
  if (!principal.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (principal.asAgent) {
    console.info("[bff] /api/workspaces authorized as machine principal (agent)");
  }
  return proxyGenesisGetJson("/workspaces", req);
}
