// BFF proxy → genesis `GET /health`, projected to the engine CAPABILITY set
// (BRO-1622): `{ engines, defaultEngine }`. The client gates the engine picker on
// this so a thread can't be silently sticky-bound to an engine the box can't run.
//
// Same auth gate as the other BFF routes (BRO-1564): a human session OR the machine
// X-Agent-Token, else 401 with no upstream call. (The raw /health is a liveness probe
// that also leaks the workspace path; getGenesisEngines strips it to engines only.)

import { authorizePrincipal } from "@/lib/api-auth";
import { getGenesisEngines } from "@/lib/genesis-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const principal = await authorizePrincipal(req);
  if (!principal.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (principal.asAgent) {
    console.info("[bff] /api/engines authorized as machine principal (agent)");
  }
  return getGenesisEngines(req);
}
