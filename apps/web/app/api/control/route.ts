// BFF proxy → genesis `POST /control` (thread session control, BRO-1576).
//
// Drives the engine's reset / interrupt / status actions (server.ts /control)
// from the PWA's slash commands (/reset, /clear). Same auth gate as the rest
// (BRO-1564): a human session OR the machine X-Agent-Token, else 401 with no
// upstream call. The body ({ threadId, action }) is forwarded verbatim.

import { authorizePrincipal } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GENESIS_URL = process.env.GENESIS_URL ?? "http://127.0.0.1:8787";
const GENESIS_TOKEN = process.env.GENESIS_TOKEN;

export async function POST(req: Request): Promise<Response> {
  const principal = await authorizePrincipal(req);
  if (!principal.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (principal.asAgent) console.info("[bff] /api/control authorized as machine principal (agent)");

  const body = await req.text();
  try {
    const upstream = await fetch(`${GENESIS_URL}/control`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(GENESIS_TOKEN ? { authorization: `Bearer ${GENESIS_TOKEN}` } : {}),
      },
      body,
      signal: req.signal,
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    // A client disconnect aborts the fetch — not an engine outage.
    if (err instanceof Error && err.name === "AbortError")
      return new Response(null, { status: 499 });
    const detail = err instanceof Error ? err.message : "upstream fetch failed";
    console.error(`[bff] genesis unreachable at ${GENESIS_URL}: ${detail}`);
    return Response.json({ error: "agent engine unreachable" }, { status: 502 });
  }
}
