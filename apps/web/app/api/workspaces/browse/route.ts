// BFF proxy → genesis `GET /workspaces/browse` (BRO-1673) — the filesystem navigator
// behind the add-by-path picker. It lists the subdirectories of a folder under the
// engine's add-roots so the owner can browse to a folder instead of typing a path.
//
// OWNER-ONLY: browsing surfaces absolute filesystem paths, so — exactly like add-by-path
// (BRO-1663, api/workspaces/route.ts) — the machine/agent principal is refused here even
// though it authenticates. The engine additionally sandboxes every path to its add-roots
// (realpath boundary); this is the identity gate on top of that.

import { authorizePrincipal } from "@/lib/api-auth";
import { proxyGenesisGetJson } from "@/lib/genesis-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const principal = await authorizePrincipal(req);
  if (!principal.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (principal.asAgent) {
    return Response.json(
      { error: "filesystem browse is restricted to the owner" },
      { status: 403 },
    );
  }
  // Forward only the `path` query param (the sole input the engine reads), URL-encoded —
  // never pass the raw request URL through. The engine owns all validation + the sandbox.
  const path = new URL(req.url).searchParams.get("path");
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  return proxyGenesisGetJson(`/workspaces/browse${qs}`, req);
}
