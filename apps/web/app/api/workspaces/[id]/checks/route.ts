// BFF proxy → genesis `GET /workspaces/:id/checks` (read-only CI status, BRO-1669).
// Returns the recent GitHub Actions runs for the workspace repo's current branch.
//
// Same auth gate as /api/threads (BRO-1564): a human session OR the machine
// X-Agent-Token, else 401 with no upstream call. Read-only (the agent principal is
// allowed). The engine shells `gh` read-only + degrades gracefully; only run metadata
// comes back — the rootPath never leaves the engine.

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
  return proxyGenesisGetJson(`/workspaces/${encodeURIComponent(id)}/checks`, req);
}
