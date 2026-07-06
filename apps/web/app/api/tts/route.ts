// BFF → OmniVoice Studio TTS (BRO-1712). Auth-gated like /api/chat; forwards a
// short text to the LOCAL OmniVoice FastAPI backend and streams the synthesized
// audio back to the browser for on-demand "read aloud".
//
// Uses OmniVoice's OpenAI-COMPATIBLE endpoint `POST /v1/audio/speech`
// ({model,input,voice,response_format,speed,instruct?} → raw audio bytes) rather
// than the multipart `/generate` — JSON in / audio out, no base64 unwrap.
// OmniVoice runs fully local on the VPS (no API key, no cloud).

import { authorizePrincipal } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OMNIVOICE_URL = process.env.OMNIVOICE_URL ?? "http://127.0.0.1:3900";
// Voice: an OmniVoice voice id / OpenAI alias (alloy, echo, …) or a saved clone id.
const OMNIVOICE_VOICE = process.env.OMNIVOICE_VOICE ?? "default";
// Output codec — mp3 keeps the response small; <audio> plays it natively.
const OMNIVOICE_FORMAT = process.env.OMNIVOICE_FORMAT ?? "mp3";
// Optional voice-style instruction (OmniVoice "voice design").
const OMNIVOICE_INSTRUCT = process.env.OMNIVOICE_INSTRUCT;

function envNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
const OMNIVOICE_SPEED = envNumber(process.env.OMNIVOICE_SPEED, 1.0);
// Bound single-request synthesis cost. CPU TTS is compute-bound (tens of seconds
// per few-hundred words), so keep the clip short by default (P20 D1).
const MAX_TTS_CHARS = envNumber(process.env.TTS_MAX_CHARS, 2000);
// Global concurrency cap so a burst of read-aloud requests can't saturate the
// shared 2-core VPS (which also runs the chat engine + OmniVoice) — P20 D1. Module
// state persists across requests in the single-process standalone server.
const MAX_CONCURRENT_TTS = envNumber(process.env.TTS_MAX_CONCURRENCY, 2);
let activeSyntheses = 0;

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
  const stop = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("? "),
    head.lastIndexOf("! "),
    head.lastIndexOf("\n"),
  );
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
  if (!text) return Response.json({ error: "no text to speak" }, { status: 400 });

  // Concurrency gate BEFORE the expensive upstream call (P20 D1). Reserve a slot;
  // release in `finally`. 429 tells the client to back off rather than pile up.
  if (activeSyntheses >= MAX_CONCURRENT_TTS) {
    return Response.json({ error: "voice engine busy, try again" }, { status: 429 });
  }
  activeSyntheses++;
  try {
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
        // Abort the synthesis if the browser disconnects (frees CPU on stop /
        // navigate — P20 R1) OR after a hard cap (cold model load costs ~5-10s).
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(180_000)]),
      });
    } catch (err) {
      // A client disconnect aborts the fetch — normal, not an engine outage.
      if (err instanceof Error && err.name === "AbortError") {
        return new Response(null, { status: 499 });
      }
      const detail = err instanceof Error ? err.message : "fetch failed";
      console.error(`[tts] OmniVoice unreachable at ${OMNIVOICE_URL}: ${detail}`);
      return Response.json({ error: "voice engine unreachable" }, { status: 502 });
    }
    if (!upstream.ok) {
      console.error(`[tts] OmniVoice /v1/audio/speech ${upstream.status}`);
      return Response.json({ error: "voice synthesis failed" }, { status: 502 });
    }

    let audio: ArrayBuffer;
    try {
      audio = await upstream.arrayBuffer();
    } catch (err) {
      // Body read can fail if the timeout fires mid-download or upstream drops.
      if (err instanceof Error && err.name === "AbortError") {
        return new Response(null, { status: 499 });
      }
      console.error("[tts] failed reading OmniVoice audio body");
      return Response.json({ error: "voice synthesis failed" }, { status: 502 });
    }
    if (audio.byteLength === 0) {
      console.error("[tts] OmniVoice returned empty audio");
      return Response.json({ error: "no audio produced" }, { status: 502 });
    }

    const contentType =
      upstream.headers.get("content-type") ?? FORMAT_CONTENT_TYPE[OMNIVOICE_FORMAT] ?? "audio/mpeg";
    return new Response(audio, {
      headers: { "content-type": contentType, "cache-control": "no-store" },
    });
  } finally {
    activeSyntheses--;
  }
}
