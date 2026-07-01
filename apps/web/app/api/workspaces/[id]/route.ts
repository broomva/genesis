// BFF proxy → genesis `DELETE /workspaces/:id` (de-register a workspace,
// BRO-1629 slice 3). Removes the workspace from the runtime registry + its FS
// manifest; the underlying repo directory is untouched (de-register ≠ delete).
//
// Same auth gate as /api/workspaces (BRO-1564): a human session OR the machine
// X-Agent-Token, else 401 with no upstream call. DELETE is mutating — the engine
// reserves/protects the default id and returns 400 on a malformed id, which the
// proxy relays. The id is a registry key (never a filesystem path).

import { authorizePrincipal } from "@/lib/api-auth";
import { proxyGenesisDelete } from "@/lib/genesis-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const principal = await authorizePrincipal(req);
  if (!principal.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (principal.asAgent) {
    console.info("[bff] DELETE /api/workspaces/:id authorized as machine principal (agent)");
  }
  const { id } = await params;
  return proxyGenesisDelete(`/workspaces/${encodeURIComponent(id)}`, req);
}
