// BFF route for per-user preferences (BRO-1618). Reads/writes the AUTH store
// (the user's `settings` JSON column) — NOT the genesis engine. Same auth-first
// shape as /api/chat: a valid principal before any DB touch.
//
//   GET  → the signed-in user's saved preferences (or defaults).
//   PUT  → merge the (partial) body over saved prefs, persist, return the result.
//
// The machine AGENT principal has no user row, so it gets defaults (GET) and a
// no-op (PUT) — it always runs with whatever the engine defaults are.

import { authorizePrincipal } from "@/lib/api-auth";
import { DEFAULT_PREFERENCES, type Preferences } from "@/lib/preferences";
import { getPreferences, upsertPreferences } from "@/lib/preferences-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const principal = await authorizePrincipal(req);
  if (!principal.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (principal.asAgent) return Response.json(DEFAULT_PREFERENCES);
  return Response.json(await getPreferences(principal.userId));
}

export async function PUT(req: Request): Promise<Response> {
  const principal = await authorizePrincipal(req);
  if (!principal.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  // No user row to attribute to → accept-and-discard so the client write path
  // stays uniform (it never special-cases the agent).
  if (principal.asAgent) return new Response(null, { status: 204 });
  const body = (await req.json().catch(() => ({}))) as Partial<Preferences>;
  // upsert sanitizes the merge ({...current, ...body}) — a partial or full body
  // is both fine; unknown/stale fields are dropped to defaults.
  return Response.json(await upsertPreferences(principal.userId, body));
}
