"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// The composer context meter (BRO-1597). A QUIET resource gauge, not a progress
// bar — the DS bans progress percentages on agent work ("presence, not progress
// — show receipts"). So the readout is absolute token counts + claude's exact
// cost in a mono receipt chip; a thin track carries the context-window fraction
// visually, shifting hue at thresholds so colour stays signal (the status ladder
// — ai-blue → warning → danger). No emoji, no percentages in the text.

export interface ContextMeterData {
  /** Latest-turn prompt size = input + cacheRead + cacheCreation (the real
   *  context-window fill right now). */
  contextTokens: number;
  /** Selected model's max context window. */
  contextWindow: number;
  /** Cumulative session cost (USD) — claude's exact numbers summed. */
  costUsd: number;
  /** Cumulative session input/output tokens (for the breakdown tooltip). */
  sessionInput: number;
  sessionOutput: number;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

function formatUsd(n: number): string {
  if (n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

export function ContextMeter({ data, className }: { data: ContextMeterData; className?: string }) {
  const { contextTokens, contextWindow, costUsd, sessionInput, sessionOutput } = data;
  // Nothing to show until a turn has reported usage (a fresh thread is silent).
  if (contextTokens === 0 && costUsd === 0) return null;

  const frac = contextWindow > 0 ? Math.min(contextTokens / contextWindow, 1) : 0;
  const fill =
    frac >= 0.92 ? "var(--bv-danger)" : frac >= 0.8 ? "var(--bv-warning)" : "var(--bv-blue)";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "flex items-center gap-2 rounded-[5px] bg-[var(--bv-canvas-soft)] px-2 py-1",
            "text-muted-foreground font-mono text-[11px] [font-variant-numeric:tabular-nums]",
            className,
          )}
          // Describe the gauge for screen readers without a bare percentage.
          aria-label={`Context ${formatTokens(contextTokens)} of ${formatTokens(contextWindow)} tokens, session cost ${formatUsd(costUsd)}`}
        >
          <span>
            {formatTokens(contextTokens)} / {formatTokens(contextWindow)}
          </span>
          <span
            aria-hidden
            className="h-[3px] w-10 overflow-hidden rounded-full bg-[var(--bv-border-5)]"
          >
            <span
              className="block h-full rounded-full transition-[width] duration-300"
              style={{ width: `${Math.max(frac * 100, 2)}%`, background: fill }}
            />
          </span>
          <span>{formatUsd(costUsd)}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="font-mono text-[11px] [font-variant-numeric:tabular-nums]"
      >
        <div className="space-y-0.5">
          <div>
            context {contextTokens.toLocaleString()} / {contextWindow.toLocaleString()}
          </div>
          <div>
            session in {sessionInput.toLocaleString()} · out {sessionOutput.toLocaleString()}
          </div>
          <div>cost {formatUsd(costUsd)}</div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
