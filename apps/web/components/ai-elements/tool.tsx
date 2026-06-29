"use client";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  BotIcon,
  ChevronDownIcon,
  FileIcon,
  GlobeIcon,
  type LucideIcon,
  SparklesIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";

// A collapsible tool-call block (BRO-1607). DS-true: monochrome at rest — the
// only colour that carries signal is the ai-blue running pulse and the danger
// hue on failure; a completed tool is silent (calm is load-bearing). No progress
// %. Renders the agent's own tools (Bash, Read, …) AND skills/subagents (Skill,
// Task) through one path — they arrive as dynamic-tool parts, distinguished only
// by name. Light enough to stay off the shiki/WASM highlighter: plain <pre>.

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

/** The tool's display name — `dynamic-tool` carries it explicitly; a static
 *  `tool-<name>` part encodes it in the type suffix. */
function toolNameOf(part: AnyToolPart): string {
  if (part.type === "dynamic-tool") return part.toolName;
  return part.type.split("-").slice(1).join("-");
}

/** Per-family icon so Bash/Read/Skill/Task read at a glance (skills + subagents
 *  get the sparkle/bot, not a generic wrench). */
function iconFor(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (n === "skill" || n.startsWith("mcp__")) return SparklesIcon;
  if (n === "task" || n === "agent") return BotIcon;
  if (n === "bash" || n === "shell" || n.includes("terminal")) return TerminalIcon;
  if (n.startsWith("web") || n === "fetch") return GlobeIcon;
  if (["read", "write", "edit", "glob", "grep", "ls", "notebookedit"].includes(n)) return FileIcon;
  return WrenchIcon;
}

/** A one-line preview of the call (the command / path / query) for the closed
 *  header — the most useful field per tool, else the first string arg. */
function previewOf(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (typeof input !== "object" || input === null) return undefined;
  const o = input as Record<string, unknown>;
  for (const k of [
    "command",
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
    "description",
    "prompt",
  ]) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  const first = Object.values(o).find((v) => typeof v === "string" && v.length > 0);
  return typeof first === "string" ? first : undefined;
}

/** Stringify a tool payload for a <pre> block, capped so a huge command output
 *  can't blow the DOM. Strings pass through; everything else is pretty JSON. */
function toBlockText(value: unknown, cap = 6000): string {
  let s: string;
  if (typeof value === "string") s = value;
  else {
    try {
      s = JSON.stringify(value, null, 2);
    } catch {
      s = String(value);
    }
  }
  return s.length > cap ? `${s.slice(0, cap)}\n… [truncated]` : s;
}

function Block({ label, text, tone }: { label: string; text: string; tone?: "danger" }) {
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground text-[0.7rem] font-medium uppercase tracking-wide">
        {label}
      </div>
      <pre
        className={cn(
          "max-h-72 overflow-auto rounded-md border px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words",
          tone === "danger"
            ? "border-[var(--bv-danger)]/30 bg-[var(--bv-danger)]/5 text-[var(--bv-danger)]"
            : "border-border bg-[var(--bv-canvas-soft-2)] text-foreground",
        )}
      >
        {text}
      </pre>
    </div>
  );
}

export function ToolPart({ part }: { part: AnyToolPart }) {
  const name = toolNameOf(part);
  const Icon = iconFor(name);
  const preview = previewOf(part.input);
  const running = part.state === "input-streaming" || part.state === "input-available";
  const errored = part.state === "output-error";
  const output = "output" in part ? part.output : undefined;
  const errorText = "errorText" in part ? part.errorText : undefined;

  return (
    <Collapsible
      className={cn(
        "group my-2 w-full overflow-hidden rounded-lg border text-left",
        errored ? "border-[var(--bv-danger)]/30" : "border-border",
      )}
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left outline-none transition-colors",
          "hover:bg-[var(--bv-frost-8)] focus-visible:ring-2 focus-visible:ring-ring/40",
        )}
      >
        <Icon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            running ? "text-[var(--bv-blue)]" : "text-muted-foreground",
          )}
        />
        <span className="text-foreground shrink-0 text-xs font-medium">{name}</span>
        {preview ? (
          <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
            {preview}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {running ? (
          <span className="bv-dot-live shrink-0" aria-label="running" />
        ) : errored ? (
          <span className="text-[var(--bv-danger)] shrink-0 text-[0.7rem]">failed</span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className="text-muted-foreground size-3.5 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2.5 px-3 pb-3 pt-1">
        {part.input !== undefined ? <Block label="Input" text={toBlockText(part.input)} /> : null}
        {errored ? (
          <Block
            label="Error"
            text={errorText ?? toBlockText(output) ?? "Tool failed"}
            tone="danger"
          />
        ) : output !== undefined ? (
          <Block label="Result" text={toBlockText(output)} />
        ) : running ? (
          <div className="text-muted-foreground text-xs">Running…</div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
