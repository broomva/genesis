"use client";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { UIMessage } from "ai";
import { ChevronDownIcon, FilePenLine } from "lucide-react";

// Per-turn "files changed" surface (BRO-1612) — makes the agent's *work* legible:
// the set of files its Edit/Write/MultiEdit calls touched, as a compact collapsible
// chip. Pure derivation from the message parts; no new persistence.

const WRITE_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);

/** Unique file paths touched by write-class tool calls in a turn, in first-seen
 *  order. Genesis emits CLI tools as dynamic-tool parts, so we read those. Pure. */
export function filesChangedFromParts(parts: UIMessage["parts"]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (p.type !== "dynamic-tool") continue;
    if (!WRITE_TOOLS.has(p.toolName.toLowerCase())) continue;
    const input = p.input;
    const fp =
      input && typeof input === "object" ? (input as Record<string, unknown>).file_path : undefined;
    if (typeof fp === "string" && fp.length > 0 && !seen.has(fp)) {
      seen.add(fp);
      out.push(fp);
    }
  }
  return out;
}

export function FilesChanged({ files }: { files: string[] }) {
  if (files.length === 0) return null;
  return (
    <Collapsible className="group border-border my-2 w-full overflow-hidden rounded-lg border">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left outline-none transition-colors hover:bg-[var(--bv-frost-8)] focus-visible:ring-2 focus-visible:ring-ring/40">
        <FilePenLine aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-foreground text-xs font-medium">
          {files.length} file{files.length > 1 ? "s" : ""} changed
        </span>
        <span className="flex-1" />
        <ChevronDownIcon
          aria-hidden
          className="text-muted-foreground size-3.5 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-2.5 pt-0.5">
        <ul className="space-y-0.5">
          {files.map((f) => (
            <li key={f} className="text-muted-foreground truncate font-mono text-xs">
              {f}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
