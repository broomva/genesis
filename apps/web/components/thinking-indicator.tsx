"use client";

import { BrainIcon, ChevronDownIcon } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

// A lightweight collapsible "the model used extended thinking" chip (BRO-1574).
// Hand-rolled on the radix Collapsible primitive rather than the AI Elements
// <Reasoning> component on purpose: <Reasoning> renders its content through
// Streamdown + @streamdown/{code,math,mermaid} (shiki/katex/mermaid WASM), which
// would land in the standalone server trace. The thinking PROSE is redacted under
// the VPS subscription auth anyway, so there is no markdown to render — only the
// token-based indicator note — so the heavyweight component buys nothing here.
export function ThinkingIndicator({ note }: { note: string }) {
  return (
    <Collapsible className="mb-1.5 w-fit max-w-[80%]">
      <CollapsibleTrigger className="group text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        <BrainIcon aria-hidden className="size-3.5 text-[var(--bv-blue)]" />
        <span>Reasoned</span>
        <ChevronDownIcon
          aria-hidden
          className="size-3 transition-transform duration-200 group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="text-muted-foreground mt-1 px-2 text-xs leading-relaxed">
        {note}
      </CollapsibleContent>
    </Collapsible>
  );
}
