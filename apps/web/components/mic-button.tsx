"use client";

import { Loader2, Mic, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Smart voice dictation (BRO-1713) — the browser's Web Speech API does the raw,
// streaming transcription (fast, no key), then /api/stt runs the Claude articulation
// pass that cleans it into well-framed text. Server-side Whisper was ~55s/clip on
// the 2-core VPS (unusable), so stage-1 lives in the browser.

type DictationState = "idle" | "listening" | "refining";

// Minimal Web Speech API surface (not in lib.dom in all TS setups).
interface SpeechResultAlt {
  transcript: string;
}
interface SpeechResult {
  isFinal: boolean;
  0: SpeechResultAlt;
}
interface SpeechResultList {
  length: number;
  [index: number]: SpeechResult;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechResultList;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useDictation(onText: (text: string) => void): {
  state: DictationState;
  supported: boolean;
  toggle: () => void;
} {
  const [state, setState] = useState<DictationState>("idle");
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef("");
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const supported = recognitionCtor() !== null;

  // Send the raw transcript for the Claude articulation pass, then hand the cleaned
  // text (or the raw, on failure) to the caller.
  const refine = useCallback((rawTranscript: string) => {
    const raw = rawTranscript.trim();
    if (!raw) {
      setState("idle");
      return;
    }
    setState("refining");
    void fetch("/api/stt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: raw }),
    })
      .then(async (res) => {
        const data = res.ok ? ((await res.json()) as { text?: string }) : null;
        onTextRef.current(data?.text || raw);
      })
      .catch(() => onTextRef.current(raw))
      .finally(() => setState("idle"));
  }, []);

  // Abort on unmount (don't refine a discarded session).
  useEffect(
    () => () => {
      const rec = recRef.current;
      recRef.current = null;
      try {
        rec?.abort();
      } catch {
        // already stopped
      }
    },
    [],
  );

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    recRef.current = rec;
    transcriptRef.current = "";
    rec.lang = typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r?.isFinal) transcriptRef.current += r[0].transcript;
      }
    };
    rec.onerror = () => setState("idle");
    rec.onend = () => {
      if (recRef.current !== rec) return; // aborted (unmount / restart) — discard
      recRef.current = null;
      refine(transcriptRef.current);
    };
    try {
      rec.start();
      setState("listening");
    } catch {
      recRef.current = null;
      setState("idle");
    }
  }, [refine]);

  const toggle = useCallback(() => {
    if (state === "listening") {
      try {
        recRef.current?.stop(); // → onend → refine
      } catch {
        setState("idle");
      }
    } else if (state === "idle") {
      start();
    }
    // refining → ignore taps
  }, [state, start]);

  return { state, supported, toggle };
}

/** Composer mic button (BRO-1713) — idle → listening (red, pulsing) → refining
 *  (spinner). Self-hides where the browser has no speech recognition. */
export function MicButton({
  onText,
  disabled,
  className,
}: {
  onText: (text: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { state, supported, toggle } = useDictation(onText);
  if (!supported) return null;
  const listening = state === "listening";
  const refining = state === "refining";
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      onClick={toggle}
      disabled={disabled || refining}
      aria-label={listening ? "Stop dictation" : refining ? "Transcribing…" : "Dictate"}
      aria-pressed={listening}
      className={cn(listening && "text-[var(--bv-danger)]", className)}
    >
      {refining ? (
        <Loader2 className="size-4 animate-spin" />
      ) : listening ? (
        <Square className="size-4 animate-pulse" />
      ) : (
        <Mic className="size-4" />
      )}
    </Button>
  );
}
