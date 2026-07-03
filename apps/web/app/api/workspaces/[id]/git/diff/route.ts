// BFF proxy → genesis `GET /workspaces/:id/git/diff?path=&cached=` (read-only file
// diff, BRO-1666 Slice 2). Returns the unified diff for one file.
//
// Same auth gate as /api/threads (BRO-1564): a human session OR the machine
// X-Agent-Token, else 401 with no upstream call. The `?path=` is RELATIVE; the engine
// validates it + passes it only as a git pathspec (never a flag). `?cached=1` diffs
// the staged changes.

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
  const url = new URL(req.url);
  const qs = new URLSearchParams();
  const path = url.searchParams.get("path");
  if (path) qs.set("path", path);
  if (url.searchParams.get("cached")) qs.set("cached", "1");
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return proxyGenesisGetJson(`/workspaces/${encodeURIComponent(id)}/git/diff${suffix}`, req);
}
