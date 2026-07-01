// BFF proxy → genesis `GET /workspaces` (selectable workspaces, BRO-1627) +
// `POST /workspaces` (self-serve discover→pick add, BRO-1629 slice 3).
//
// Same auth gate as /api/threads (BRO-1564): a human session OR the machine
// X-Agent-Token, else 401 with no upstream call. The list exposes workspace ids
// + display names (rootPaths are stripped server-side), so it must never be
// reachable unauthenticated — the topology itself is sensitive. POST is a
// mutating verb (registers a picked dir under the engine's allow-root) — the
// same gate applies, and the client only ever sends a directory NAME (the engine
// derives + validates the filesystem path; the path never crosses this boundary).

import { authorizePrincipal } from "@/lib/api-auth";
import { proxyGenesisGetJson, proxyGenesisPostJson } from "@/lib/genesis-proxy";

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

export async function POST(req: Request): Promise<Response> {
  const principal = await authorizePrincipal(req);
  if (!principal.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (principal.asAgent) {
    console.info("[bff] POST /api/workspaces authorized as machine principal (agent)");
  }
  // Pass the body through untouched ({ pick: <dir name> }) — the engine owns all
  // validation (charset, traversal, realpath boundary, git check) and returns a
  // safe 400 message on a bad pick, which proxyGenesisPostJson relays verbatim.
  const body = await req.text();
  return proxyGenesisPostJson("/workspaces", body, req);
}
