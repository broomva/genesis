"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// The composer context meter (BRO-1597, redesigned BRO-1604). A compact trigger
// in the composer FOOTER (a thin context-fill bar + the session cost, quiet at
// rest) opens a usage popover with the full breakdown — moving it off the top of
// the composer (which added awkward spacing) into the toolbar. Still DS-true: the
// readout is absolute token counts + claude's exact cost (no bare progress %);
// the thin track carries the context-window fraction visually and shifts hue at
// thresholds so colour stays signal (the status ladder — ai-blue → warning →
// danger). Popovers earn glass.

export interface ContextMeterData {
  /** Latest-turn prompt size = input + cacheRead + cacheCreation (current fill). */
  contextTokens: number;
  /** Selected model's max context window. */
  contextWindow: number;
  /** Cumulative session cost (USD) — claude's exact numbers summed. */
  costUsd: number;
  /** Cumulative session token sums for the breakdown. */
  sessionInput: number;
  sessionOutput: number;
  sessionCacheRead: number;
  sessionCacheWrite: number;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

function formatUsd(n: number): string {
  if (n <= 0) return "$0.00";
  if (n < 0.001) return "<$0.001";
  if (n < 0.01) return `$${n.toFixed(4).replace(/0+$/, "")}`;
  return `$${n.toFixed(2)}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

export function ContextMeter({ data, className }: { data: ContextMeterData; className?: string }) {
  const {
    contextTokens,
    contextWindow,
    costUsd,
    sessionInput,
    sessionOutput,
    sessionCacheRead,
    sessionCacheWrite,
  } = data;
  // Nothing to show until a turn has reported usage (a fresh thread is silent).
  if (contextTokens === 0 && costUsd === 0) return null;

  const frac = contextWindow > 0 ? Math.min(contextTokens / contextWindow, 1) : 0;
  const fill =
    frac >= 0.92 ? "var(--bv-danger)" : frac >= 0.8 ? "var(--bv-warning)" : "var(--bv-blue)";
  const status = frac >= 0.92 ? "over limit" : frac >= 0.8 ? "near limit" : undefined;

  // Ring geometry (BRO-1606): a small donut gauge whose arc fills clockwise from
  // the top with the context fraction. The fill LEVEL itself is the non-colour
  // cue (a fuller ring = more usage, WCAG 1.4.1); the threshold hue + the
  // aria-label word reinforce it.
  const RING = 16;
  const STROKE = 2.5;
  const radius = (RING - STROKE) / 2;
  const circ = 2 * Math.PI * radius;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Session usage — context ${formatTokens(contextTokens)} of ${formatTokens(contextWindow)} tokens${status ? `, ${status}` : ""}, cost ${formatUsd(costUsd)}. Open breakdown.`}
          className={cn(
            "flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors",
            "hover:bg-[var(--bv-frost-8)] hover:text-foreground",
            "data-[state=open]:bg-[var(--bv-frost-8)] data-[state=open]:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            className,
          )}
        >
          <svg
            width={RING}
            height={RING}
            viewBox={`0 0 ${RING} ${RING}`}
            className="-rotate-90"
            aria-hidden="true"
            role="presentation"
          >
            {/* Track — the faint full circle. */}
            <circle
              cx={RING / 2}
              cy={RING / 2}
              r={radius}
              fill="none"
              stroke="var(--bv-border-15)"
              strokeWidth={STROKE}
            />
            {/* Fill — the arc that grows with the context fraction. */}
            <circle
              cx={RING / 2}
              cy={RING / 2}
              r={radius}
              fill="none"
              stroke={fill}
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={circ}
              strokeDashoffset={circ * (1 - frac)}
              className="transition-[stroke-dashoffset] duration-300"
            />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-64">
        <div className="space-y-2.5">
          <div className="text-foreground text-sm font-medium">Session usage</div>

          <div>
            <div className="flex items-baseline justify-between font-mono text-xs [font-variant-numeric:tabular-nums]">
              <span className="text-muted-foreground">Context</span>
              <span className="text-foreground">
                {formatTokens(contextTokens)} / {formatTokens(contextWindow)}
              </span>
            </div>
            <span
              aria-hidden
              className="mt-1.5 block h-[5px] w-full overflow-hidden rounded-full bg-[var(--bv-border-5)]"
            >
              <span
                className="block h-full rounded-full transition-[width] duration-300"
                style={{ width: `${Math.max(frac * 100, 2)}%`, background: fill }}
              />
            </span>
          </div>

          <div className="flex items-baseline justify-between font-mono text-xs [font-variant-numeric:tabular-nums]">
            <span className="text-muted-foreground">Cost</span>
            <span className="text-foreground">{formatUsd(costUsd)}</span>
          </div>

          <div className="border-border border-t" />

          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px] [font-variant-numeric:tabular-nums]">
            <Stat label="Input" value={formatTokens(sessionInput)} />
            <Stat label="Output" value={formatTokens(sessionOutput)} />
            <Stat label="Cache read" value={formatTokens(sessionCacheRead)} />
            <Stat label="Cache write" value={formatTokens(sessionCacheWrite)} />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
