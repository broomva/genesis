// BFF proxy → genesis `GET /workspaces/:id/file?path=` (read a file, BRO-1666
// Slice 1). Returns `{ path, content, truncated, binary, size }` for a file under
// the workspace's server-only rootPath.
//
// Same auth gate as /api/threads (BRO-1564): a human session OR the machine
// X-Agent-Token, else 401 with no upstream call. The `?path=` is RELATIVE; the
// engine sandboxes it (realpath boundary) + caps the read; the rootPath never
// leaves the engine (only the relative path + contents come back).

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
  return proxyGenesisGetJson(`/workspaces/${encodeURIComponent(id)}/file${qs}`, req);
}
