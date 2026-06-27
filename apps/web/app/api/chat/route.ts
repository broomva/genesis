// BFF proxy → genesis `/api/chat`.
//
// The PWA's `useChat` POSTs the AI SDK UI-message-stream request body here; we
// forward it verbatim to the genesis engine and STREAM the upstream response
// back untouched. The upstream speaks the Vercel AI SDK UI message stream
// protocol (SSE: `x-vercel-ai-ui-message-stream: v1`), so the one thing that
// must be correct is the passthrough: never await/buffer `upstream.body`.
//
// Auth gate: this route is the REAL enforcement point (middleware does only an
// optimistic cookie check). The first thing POST does is verify a valid Better
// Auth session via `auth.api.getSession`; with no session it returns 401 and
// never touches the upstream engine. The upstream credential remains a
// server-only bearer token (GENESIS_TOKEN) the browser never sees.

import { auth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GENESIS_URL = process.env.GENESIS_URL ?? "http://127.0.0.1:8787";
const GENESIS_TOKEN = process.env.GENESIS_TOKEN;

// Headers worth mirroring from the upstream streaming response so the AI SDK
// client parses the stream correctly (content-type + the AI-SDK stream marker).
const STREAM_HEADER_PREFIXES = ["content-type", "cache-control", "x-vercel-ai-"];

export async function POST(req: Request): Promise<Response> {
  // AUTH GATE — must be first. No session ⇒ 401, no upstream call.
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Read the raw body once; forward it byte-identical (it already IS the AI SDK
  // request shape genesis `parseChatRequest` expects: { id, messages: [...] }).
  const body = await req.text();

  let upstream: Response;
  try {
    upstream = await fetch(`${GENESIS_URL}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(GENESIS_TOKEN ? { authorization: `Bearer ${GENESIS_TOKEN}` } : {}),
      },
      body,
      // Abort the Genesis run if the browser disconnects — releases the engine
      // instead of letting an abandoned run continue with no listener.
      signal: req.signal,
      // Required by undici/Node to stream a request+response pair.
      // @ts-expect-error — `duplex` is valid at runtime; not yet in lib.dom types.
      duplex: "half",
    });
  } catch (err) {
    // Log the internal detail (host:port, cause) server-side only; the browser
    // gets a generic message so the upstream address never leaks to the client.
    const detail = err instanceof Error ? err.message : "upstream fetch failed";
    console.error(`[bff] genesis unreachable at ${GENESIS_URL}: ${detail}`);
    return Response.json({ error: "agent engine unreachable" }, { status: 502 });
  }

  // Copy only the headers that matter for the stream; drop hop-by-hop ones.
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (STREAM_HEADER_PREFIXES.some((p) => k.startsWith(p))) {
      headers.set(key, value);
    }
  });
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/event-stream; charset=utf-8");
  }

  // CRITICAL: pass the body through unbuffered. Returning `upstream.body`
  // streams chunks to the client as they arrive.
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
