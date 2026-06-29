"use client";

import { TriangleAlert } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// The composer context meter (BRO-1597). A QUIET resource gauge, not a progress
// bar — the DS bans progress percentages on agent work ("presence, not progress
// — show receipts"). So the readout is absolute token counts + claude's exact
// cost in a mono receipt chip; a thin track carries the context-window fraction
// visually, shifting hue at thresholds so colour stays signal (the status ladder
// — ai-blue → warning → danger). No emoji, no percentages in the text.
//
// SCOPE: fed by the PRINT engine (claude -p), which emits usage + total_cost_usd
// on its terminal result — the production default on the VPS. Under the exempt
// INTERACTIVE engine (GENESIS_ENGINE=interactive) the synthesized result carries
// no usage yet, so the meter stays hidden there; wiring the statusline usage is a
// tracked follow-up. The meter degrades gracefully (renders nothing without data).

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
  // Preserve the exact-cost signal for sub-cent amounts (BRO-1597) — collapsing
  // every small turn to "<$0.01" defeats the point; show real digits, only
  // bottoming out below a tenth of a cent.
  if (n < 0.001) return "<$0.001";
  if (n < 0.01) return `$${n.toFixed(4).replace(/0+$/, "")}`;
  return `$${n.toFixed(2)}`;
}

export function ContextMeter({ data, className }: { data: ContextMeterData; className?: string }) {
  const { contextTokens, contextWindow, costUsd, sessionInput, sessionOutput } = data;
  // Nothing to show until a turn has reported usage (a fresh thread is silent).
  if (contextTokens === 0 && costUsd === 0) return null;

  const frac = contextWindow > 0 ? Math.min(contextTokens / contextWindow, 1) : 0;
  const fill =
    frac >= 0.92 ? "var(--bv-danger)" : frac >= 0.8 ? "var(--bv-warning)" : "var(--bv-blue)";
  // Threshold status carried by SHAPE + WORD, never colour alone (WCAG 1.4.1):
  // the alert glyph + the aria-label word appear/disappear at the same points
  // the track changes hue, so colourblind + screen-reader users get the cue too.
  const status = frac >= 0.92 ? "over limit" : frac >= 0.8 ? "near limit" : undefined;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A real <button> (not a div) — keyboard-focusable so the breakdown
            tooltip is reachable without a pointer, gives the aria-label a role
            that announces it, and skips the composer addon's click-to-focus
            steal (P20 a11y). type=button so it never submits the composer form. */}
        <button
          type="button"
          className={cn(
            "flex items-center gap-2 rounded-[5px] bg-[var(--bv-canvas-soft)] px-2 py-1",
            "text-muted-foreground font-mono text-[11px] [font-variant-numeric:tabular-nums]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            className,
          )}
          // Describe the gauge for screen readers — counts + threshold word, no %.
          aria-label={`Context ${formatTokens(contextTokens)} of ${formatTokens(contextWindow)} tokens${status ? `, ${status}` : ""}, session cost ${formatUsd(costUsd)}`}
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
          {status ? <TriangleAlert aria-hidden className="size-3" style={{ color: fill }} /> : null}
          <span>{formatUsd(costUsd)}</span>
        </button>
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
