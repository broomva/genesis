// Server→engine GET proxy for read-only JSON resources (BRO-1567 thread list +
// history). Shared by the /api/threads* routes so the upstream address, bearer,
// and error handling live in one place.
//
// The upstream `Authorization: Bearer GENESIS_TOKEN` is the server→engine
// credential (distinct from the client's session cookie / X-Agent-Token, which
// the route's authorizePrincipal already verified). On an unreachable engine we
// log the address server-side only and return a generic 502 — the host:port
// never leaks to the browser.

const GENESIS_URL = process.env.GENESIS_URL ?? "http://127.0.0.1:8787";
const GENESIS_TOKEN = process.env.GENESIS_TOKEN;

/** GET a JSON resource from the genesis engine and pass the body + status
 *  through untouched. `path` must start with "/". */
export async function proxyGenesisGetJson(path: string, req: Request): Promise<Response> {
  try {
    const upstream = await fetch(`${GENESIS_URL}${path}`, {
      headers: { ...(GENESIS_TOKEN ? { authorization: `Bearer ${GENESIS_TOKEN}` } : {}) },
      // Abort the upstream read if the browser disconnects.
      signal: req.signal,
    });
    // Pass the raw body through rather than re-serializing, so the response is
    // byte-identical to what the engine produced.
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "upstream fetch failed";
    console.error(`[bff] genesis unreachable at ${GENESIS_URL}: ${detail}`);
    return Response.json({ error: "agent engine unreachable" }, { status: 502 });
  }
}
