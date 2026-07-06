"use client";

import { formatClock, formatDuration } from "@/lib/duration";
import { cn } from "@/lib/utils";
import { Check, Copy, Loader2, RotateCcw, Square, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

// Run-time counter + message actions (BRO-1610). DS-calm: run time is a quiet
// persistent readout; copy/retry are ghost icons revealed on hover (always shown
// on touch). ai-blue only on the copied tick + focus ring.

/** Elapsed ms since `active` became true, ticking ~1/s; resets to 0 when inactive. */
export function useElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(id);
  }, [active]);
  return elapsed;
}

/** Live ticking run-time for the running signal ("0:24"). Renders nothing at rest. */
export function RunTimer({ active }: { active: boolean }) {
  const elapsed = useElapsed(active);
  if (!active) return null;
  // Not aria-live — the ticking value shouldn't re-announce every second; the
  // running label ("Thinking"/"Responding") already conveys state. Labelled so
  // it's identifiable when navigated.
  return (
    <span aria-label="Elapsed time" className="[font-variant-numeric:tabular-nums]">
      {formatClock(elapsed)}
    </span>
  );
}

/** Copy-to-clipboard with a 1.5s "copied" tick. */
export function useCopy(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    if (!text || typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, []);
  return { copied, copy };
}

const ICON_BTN = cn(
  "inline-flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors",
  "hover:bg-[var(--bv-frost-8)] hover:text-foreground",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
  "disabled:pointer-events-none disabled:opacity-40 [@media(pointer:coarse)]:size-9",
);

/** A copy icon button for a (possibly dynamic) string. */
export function CopyButton({
  text,
  label = "Copy",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      disabled={!text}
      aria-label={copied ? "Copied" : label}
      className={cn(ICON_BTN, className)}
    >
      {copied ? (
        <Check className="size-3.5 text-[var(--bv-blue)]" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}

/** On-demand text-to-speech (BRO-1711) — POSTs the text to /api/tts (OmniVoice),
 *  plays the returned WAV, and toggles play/stop. One <audio> element per hook
 *  instance; the blob URL is revoked on replace + unmount. Errors fail quiet (the
 *  button just returns to idle) so a voice-engine hiccup never breaks the chat. */
export function useSpeak(): {
  speaking: boolean;
  loading: boolean;
  toggle: (text: string) => void;
} {
  const [speaking, setSpeaking] = useState(false);
  const [loading, setLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  // A generation token so a stale fetch (user pressed stop, or started another)
  // can't resurrect playback after it was cancelled.
  const genRef = useRef(0);

  const cleanupAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    genRef.current++; // invalidate any in-flight fetch
    cleanupAudio();
    setSpeaking(false);
    setLoading(false);
  }, [cleanupAudio]);

  // Stop + release on unmount.
  useEffect(() => stop, [stop]);

  const toggle = useCallback(
    (text: string) => {
      if (speaking || loading) {
        stop();
        return;
      }
      if (!text.trim()) return;
      const gen = ++genRef.current;
      setLoading(true);
      void (async () => {
        try {
          const res = await fetch("/api/tts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
          });
          if (!res.ok) throw new Error(`tts ${res.status}`);
          const blob = await res.blob();
          if (gen !== genRef.current) return; // cancelled while synthesizing
          cleanupAudio();
          const url = URL.createObjectURL(blob);
          urlRef.current = url;
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended = () => {
            if (gen === genRef.current) setSpeaking(false);
          };
          audio.onerror = () => {
            if (gen === genRef.current) setSpeaking(false);
          };
          await audio.play();
          if (gen !== genRef.current) {
            cleanupAudio();
            return;
          }
          setSpeaking(true);
        } catch {
          if (gen === genRef.current) setSpeaking(false);
        } finally {
          if (gen === genRef.current) setLoading(false);
        }
      })();
    },
    [speaking, loading, stop, cleanupAudio],
  );

  return { speaking, loading, toggle };
}

/** A speaker button that reads `text` aloud on demand via {@link useSpeak}. */
export function SpeakButton({
  text,
  label = "Read aloud",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const { speaking, loading, toggle } = useSpeak();
  return (
    <button
      type="button"
      onClick={() => toggle(text)}
      disabled={!text}
      aria-label={speaking || loading ? "Stop" : label}
      aria-pressed={speaking}
      className={cn(ICON_BTN, className)}
    >
      {loading ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : speaking ? (
        <Square className="size-3.5 text-[var(--bv-blue)]" />
      ) : (
        <Volume2 className="size-3.5" />
      )}
    </button>
  );
}

/** The footer under an assistant message: run time (persistent, quiet) + copy +
 *  speak + retry (revealed on hover / always on touch). */
export function MessageActions({
  text,
  durationMs,
  onRetry,
  canRetry,
}: {
  text: string;
  durationMs?: number;
  onRetry?: () => void;
  canRetry?: boolean;
}) {
  const runtime = formatDuration(durationMs);
  if (!runtime && !text) return null;
  return (
    <div className="text-muted-foreground mt-1.5 flex items-center gap-1.5 text-xs">
      {runtime ? (
        <span
          aria-label={`Run time ${runtime}`}
          className="[font-variant-numeric:tabular-nums]"
          title="Run time"
        >
          {runtime}
        </span>
      ) : null}
      <span className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100">
        <CopyButton text={text} label="Copy response" />
        {/* Read the response aloud on demand (BRO-1711) — OmniVoice TTS. */}
        <SpeakButton text={text} label="Read response aloud" />
        {canRetry && onRetry ? (
          <button type="button" onClick={onRetry} aria-label="Retry" className={ICON_BTN}>
            <RotateCcw className="size-3.5" />
          </button>
        ) : null}
      </span>
    </div>
  );
}
