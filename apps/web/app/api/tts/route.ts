// BFF → OmniVoice Studio TTS (BRO-1711). Auth-gated like /api/chat; forwards a
// short text to the LOCAL OmniVoice FastAPI backend and streams the synthesized
// audio back to the browser for on-demand "read aloud".
//
// Uses OmniVoice's OpenAI-COMPATIBLE endpoint `POST /v1/audio/speech`
// ({model,input,voice,response_format,speed,instruct?} → raw audio bytes) rather
// than the multipart `/generate` — it's JSON in / audio out, no base64 unwrap.
// OmniVoice runs fully local on the VPS (no API key, no cloud).

import { authorizePrincipal } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OMNIVOICE_URL = process.env.OMNIVOICE_URL ?? "http://127.0.0.1:3900";
// Voice: an OmniVoice voice id / OpenAI alias (alloy, echo, …) or a saved clone id.
const OMNIVOICE_VOICE = process.env.OMNIVOICE_VOICE ?? "default";
// Output codec — mp3 keeps the response small; <audio> plays it natively.
const OMNIVOICE_FORMAT = process.env.OMNIVOICE_FORMAT ?? "mp3";
const OMNIVOICE_SPEED = Number(process.env.OMNIVOICE_SPEED ?? 1.0);
// Optional voice-style instruction (OmniVoice "voice design").
const OMNIVOICE_INSTRUCT = process.env.OMNIVOICE_INSTRUCT;
// Bound synthesis time — a huge reply would take minutes on CPU. Truncate near a
// sentence boundary so speech never cuts mid-word.
const MAX_TTS_CHARS = Number(process.env.TTS_MAX_CHARS ?? 4000);

const FORMAT_CONTENT_TYPE: Record<string, string> = {
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/L16",
};

/** Truncate near the last sentence end / whitespace before the cap. */
function clampText(text: string): string {
  if (text.length <= MAX_TTS_CHARS) return text;
  const head = text.slice(0, MAX_TTS_CHARS);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("\n"), head.lastIndexOf("! "));
  return (stop > MAX_TTS_CHARS * 0.5 ? head.slice(0, stop + 1) : head).trim();
}

export async function POST(req: Request): Promise<Response> {
  const principal = await authorizePrincipal(req);
  if (!principal.ok) return Response.json({ error: "unauthorized" }, { status: 401 });

  let text: string;
  try {
    const body = (await req.json()) as { text?: unknown };
    text = typeof body.text === "string" ? body.text.trim() : "";
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!text) return Response.json({ error: "no text to speak" }, { status: 400 });
  text = clampText(text);

  const payload: Record<string, unknown> = {
    model: "omnivoice",
    input: text,
    voice: OMNIVOICE_VOICE,
    response_format: OMNIVOICE_FORMAT,
    speed: OMNIVOICE_SPEED,
  };
  if (OMNIVOICE_INSTRUCT) payload.instruct = OMNIVOICE_INSTRUCT;

  let upstream: Response;
  try {
    upstream = await fetch(`${OMNIVOICE_URL}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      // CPU diffusion is slow + a cold model load costs ~5-10s; generous timeout.
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "fetch failed";
    console.error(`[tts] OmniVoice unreachable at ${OMNIVOICE_URL}: ${detail}`);
    return Response.json({ error: "voice engine unreachable" }, { status: 502 });
  }
  if (!upstream.ok) {
    console.error(`[tts] OmniVoice /v1/audio/speech ${upstream.status}`);
    return Response.json({ error: "voice synthesis failed" }, { status: 502 });
  }

  const audio = await upstream.arrayBuffer();
  if (audio.byteLength === 0) {
    console.error("[tts] OmniVoice returned empty audio");
    return Response.json({ error: "no audio produced" }, { status: 502 });
  }

  const contentType =
    upstream.headers.get("content-type") ?? FORMAT_CONTENT_TYPE[OMNIVOICE_FORMAT] ?? "audio/mpeg";
  return new Response(audio, {
    headers: { "content-type": contentType, "cache-control": "no-store" },
  });
}
