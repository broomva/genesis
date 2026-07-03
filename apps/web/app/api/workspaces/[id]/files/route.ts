// BFF proxy → genesis `GET /workspaces/:id/files?path=` (read-only fs tree,
// BRO-1666 Slice 1). Lists a directory under the workspace's server-only rootPath.
//
// Same auth gate as /api/threads (BRO-1564): a human session OR the machine
// X-Agent-Token, else 401 with no upstream call. Reads are fine for the agent
// principal (browsing is not mutating; writes — Slice 3 commit/push — will be
// owner-only). The `?path=` is RELATIVE; the engine sandboxes it under the root
// (realpath boundary) and returns only relative names — the rootPath never crosses
// this boundary.

import { authorizePrincipal } from "@/lib/api-auth";
import { proxyGenesisGetJson } from "@/lib/genesis-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const principal = await authorizePrincipal(req);
  if (!principal.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const path = new URL(req.url).searchParams.get("path") ?? "";
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  return proxyGenesisGetJson(`/workspaces/${encodeURIComponent(id)}/files${qs}`, req);
}
