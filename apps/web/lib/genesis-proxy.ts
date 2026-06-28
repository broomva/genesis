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
    // byte-identical to what the engine produced. Mirror the upstream
    // content-type for fidelity (defaulting to JSON, which is all /threads* emit).
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      },
    });
  } catch (err) {
    return upstreamError(err);
  }
}

/** POST a JSON body to the genesis engine and pass the body + status through
 *  (BRO-1576). `path` must start with "/". The caller's authorizePrincipal must
 *  already have run; this only adds the server→engine bearer. */
export async function proxyGenesisPostJson(
  path: string,
  body: string,
  req: Request,
): Promise<Response> {
  try {
    const upstream = await fetch(`${GENESIS_URL}${path}`, {
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
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      },
    });
  } catch (err) {
    return upstreamError(err);
  }
}

/** Shared error mapping: a client-disconnect AbortError → 499 (no alarm); any
 *  other failure logs the address server-side only and returns a generic 502. */
function upstreamError(err: unknown): Response {
  if (err instanceof Error && err.name === "AbortError") {
    return new Response(null, { status: 499 });
  }
  const detail = err instanceof Error ? err.message : "upstream fetch failed";
  console.error(`[bff] genesis unreachable at ${GENESIS_URL}: ${detail}`);
  return Response.json({ error: "agent engine unreachable" }, { status: 502 });
}
