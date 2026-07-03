// BFF proxy → genesis `GET /workspaces/:id/file/raw?path=` (raw file bytes, BRO-1667).
// Serves images / pdf / html inline for the rich file viewer.
//
// Same auth gate as /api/threads (BRO-1564): a human session OR the machine
// X-Agent-Token, else 401 with no upstream call. Streams the bytes through with the
// engine's Content-Type (name-derived, never sniffed) + hardening headers
// (X-Content-Type-Options: nosniff + a strict CSP), so a mislabeled / HTML / SVG file
// can't execute if opened as a top-level document. The `?path=` is RELATIVE; the
// engine sandboxes it; the rootPath never leaves the engine.

import { authorizePrincipal } from "@/lib/api-auth";
import { proxyGenesisGetRaw } from "@/lib/genesis-proxy";

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
  return proxyGenesisGetRaw(`/workspaces/${encodeURIComponent(id)}/file/raw${qs}`, req);
}
