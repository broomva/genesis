// BFF proxy → genesis `GET /workspaces/available` (discover→pick candidates,
// BRO-1629 slice 3): git repos under the engine's allow-root (GENESIS_PROJECTS_
// ROOT) that aren't already registered. Returns { available: [{id, name}] }.
//
// Same auth gate as /api/workspaces (BRO-1564): a human session OR the machine
// X-Agent-Token, else 401 with no upstream call. Directory NAMES under the
// projects root are topology — never reachable unauthenticated. (Filesystem
// paths are NOT in this payload; the engine only surfaces the pickable name.)

import { authorizePrincipal } from "@/lib/api-auth";
import { proxyGenesisGetJson } from "@/lib/genesis-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const principal = await authorizePrincipal(req);
  if (!principal.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (principal.asAgent) {
    console.info("[bff] /api/workspaces/available authorized as machine principal (agent)");
  }
  return proxyGenesisGetJson("/workspaces/available", req);
}
