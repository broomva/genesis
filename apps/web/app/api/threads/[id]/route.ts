// BFF proxy → genesis `GET /threads/:id` (one thread's transcript, BRO-1567) +
// `DELETE /threads/:id` (hard-delete a thread, BRO-1592).
//
// Same auth gate as /api/chat + /api/threads (BRO-1564): a human session OR the
// machine X-Agent-Token, else 401 with no upstream call. History is per-thread
// session data — it must never be reachable unauthenticated.

import { authorizePrincipal } from "@/lib/api-auth";
import { proxyGenesisDelete, proxyGenesisGetJson } from "@/lib/genesis-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const principal = await authorizePrincipal(req);
  if (!principal.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  return proxyGenesisGetJson(`/threads/${encodeURIComponent(id)}`, req);
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const principal = await authorizePrincipal(req);
  if (!principal.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (principal.asAgent)
    console.info("[bff] DELETE /api/threads/:id authorized as machine principal (agent)");
  const { id } = await params;
  return proxyGenesisDelete(`/threads/${encodeURIComponent(id)}`, req);
}
