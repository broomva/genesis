// BFF proxy → genesis `/api/chat`.
//
// The PWA's `useChat` POSTs the AI SDK UI-message-stream request body here; we
// forward it verbatim to the genesis engine and STREAM the upstream response
// back untouched. The upstream speaks the Vercel AI SDK UI message stream
// protocol (SSE: `x-vercel-ai-ui-message-stream: v1`), so the one thing that
// must be correct is the passthrough: never await/buffer `upstream.body`.
//
// Auth gate: this route is the REAL enforcement point (middleware does only an
// optimistic cookie check). POST authenticates one of TWO principals before it
// touches the upstream engine:
//   • HUMAN  — a valid Better Auth session (passkey). This is the primary path;
//     a browser fetch carries the session cookie automatically.
//   • AGENT  — a server-only machine token presented in the `X-Agent-Token`
//     header, compared constant-time to AGENT_TOKEN. Lets the agent operate /
//     dogfood the channel without a biometric authenticator. Distinct header
//     from the upstream `Authorization: Bearer GENESIS_TOKEN` (which the route
//     sets itself, server→engine) — no collision with the client credential.
// With NEITHER ⇒ 401, no upstream call. AGENT_TOKEN unset ⇒ the agent path is
// hard-disabled (fail closed), so it can never weaken the gate when absent.

import { auth } from "@/lib/auth";
import { timingSafeEqual } from "@/lib/timing-safe-equal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GENESIS_URL = process.env.GENESIS_URL ?? "http://127.0.0.1:8787";
const GENESIS_TOKEN = process.env.GENESIS_TOKEN;
// Machine-principal token. Unset ⇒ no agent path (fail closed).
const AGENT_TOKEN = process.env.AGENT_TOKEN;

// Headers worth mirroring from the upstream streaming response so the AI SDK
// client parses the stream correctly (content-type + the AI-SDK stream marker).
const STREAM_HEADER_PREFIXES = ["content-type", "cache-control", "x-vercel-ai-"];

// True iff a valid machine token is presented. Fail-closed: no env ⇒ false even
// for an empty header, so the agent path simply does not exist unless configured.
function agentAuthorized(req: Request): boolean {
  if (!AGENT_TOKEN) return false;
  const provided = req.headers.get("x-agent-token") ?? "";
  return provided.length > 0 && timingSafeEqual(provided, AGENT_TOKEN);
}

export async function POST(req: Request): Promise<Response> {
  // AUTH GATE — must be first. Human session OR machine token; else 401, no
  // upstream call. The session check stays primary and unchanged.
  const session = await auth.api.getSession({ headers: req.headers });
  const asAgent = !session && agentAuthorized(req);
  if (!session && !asAgent) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // Attribute the principal server-side (never impersonates the owner user).
  if (asAgent) console.info("[bff] /api/chat authorized as machine principal (agent)");

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
