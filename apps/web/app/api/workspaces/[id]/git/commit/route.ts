// BFF proxy → genesis `POST /workspaces/:id/git/commit` (Commit & Push, BRO-1666
// Slice 3). The ONE write op — stage all + commit + optional push.
//
// OWNER-ONLY (BRO-1663 posture): a commit/push runs git in the user's repo and can
// push to their real remote, so the machine/agent principal is REFUSED (403) — only
// a human Better Auth session may write. (Reads — status/diff/files — allow the agent;
// writes do not.) The engine still validates the message + uses a fixed argv; this is
// the identity gate on top of that.

import { authorizePrincipal } from "@/lib/api-auth";
import { proxyGenesisPostJson } from "@/lib/genesis-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const principal = await authorizePrincipal(req);
  if (!principal.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (principal.asAgent) {
    return Response.json({ error: "commit & push is restricted to the owner" }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.text();
  return proxyGenesisPostJson(`/workspaces/${encodeURIComponent(id)}/git/commit`, body, req);
}
