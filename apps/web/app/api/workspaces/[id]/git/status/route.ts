// BFF proxy → genesis `GET /workspaces/:id/git/status` (read-only git status,
// BRO-1666 Slice 2). Returns branch + ahead/behind + per-file status with +/- counts.
//
// Same auth gate as /api/threads (BRO-1564): a human session OR the machine
// X-Agent-Token, else 401 with no upstream call. Read-only (status), so the agent
// principal is allowed (writes — Slice 3 commit/push — will be owner-only). The
// engine runs git under the workspace's server-only rootPath; only relative paths +
// status come back.

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
  return proxyGenesisGetJson(`/workspaces/${encodeURIComponent(id)}/git/status`, req);
}
