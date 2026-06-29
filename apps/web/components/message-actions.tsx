"use client";

import { formatClock, formatDuration } from "@/lib/duration";
import { cn } from "@/lib/utils";
import { Check, Copy, RotateCcw } from "lucide-react";
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

/** The footer under an assistant message: run time (persistent, quiet) + copy +
 *  retry (revealed on hover / always on touch). */
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
        {canRetry && onRetry ? (
          <button type="button" onClick={onRetry} aria-label="Retry" className={ICON_BTN}>
            <RotateCcw className="size-3.5" />
          </button>
        ) : null}
      </span>
    </div>
  );
}
