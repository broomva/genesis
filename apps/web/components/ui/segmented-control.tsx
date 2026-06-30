"use client";

import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

// DS segmented control (BRO-1618) — a small set of mutually-exclusive choices,
// all visible at once (theme light/dark/system; engine print/interactive later).
// Built over radix ToggleGroup. Use type="single"; the consumer guards the empty
// deselect (radix allows toggling the active item off).
function SegmentedControl({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="segmented-control"
      className={cn(
        "inline-flex w-fit items-center gap-0.5 rounded-lg border border-input bg-muted/40 p-0.5",
        className,
      )}
      {...props}
    />
  );
}

function SegmentedControlItem({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="segmented-control-item"
      className={cn(
        "inline-flex h-7 items-center justify-center gap-1.5 rounded-[min(var(--radius-md),8px)] px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none select-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm [@media(pointer:coarse)]:h-9 [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export { SegmentedControl, SegmentedControlItem };
