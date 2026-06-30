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

// A collapsible tool-call block (BRO-1607, per-tool rendering BRO-1612). DS-true:
// monochrome at rest — the only colour that carries signal is the ai-blue running
// pulse, the danger hue on failure, and green/red INSIDE a diff (a diff IS signal).
// No progress %. Bash → terminal, Edit/Write/MultiEdit → diff, Read/Grep/Glob →
// code/list, default → generic JSON. Light: plain <pre>/<div>, no shiki/WASM.

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

/** The tool's display name — `dynamic-tool` carries it explicitly; a static
 *  `tool-<name>` part encodes it in the type suffix. */
function toolNameOf(part: AnyToolPart): string {
  if (part.type === "dynamic-tool") return part.toolName;
  return part.type.split("-").slice(1).join("-");
}

function iconFor(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (n === "skill" || n.startsWith("mcp__")) return SparklesIcon;
  if (n === "task" || n === "agent") return BotIcon;
  if (n === "bash" || n === "shell" || n.includes("terminal")) return TerminalIcon;
  if (n.startsWith("web") || n === "fetch") return GlobeIcon;
  if (["read", "write", "edit", "multiedit", "glob", "grep", "ls", "notebookedit"].includes(n))
    return FileIcon;
  return WrenchIcon;
}

/** A one-line preview of the call for the closed header. */
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

/** Safely read a string field from a tool input object. */
function str(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

const CAP = 6000;
function toBlockText(value: unknown, cap = CAP): string {
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

/** A tool output → display text (string passthrough, else pretty JSON). */
function outText(output: unknown, errored: boolean, errorText?: string): string | undefined {
  if (errored) {
    if (errorText && errorText.trim().length > 0) return capStr(errorText);
    return output !== undefined ? toBlockText(output) : "Tool failed";
  }
  if (output === undefined) return undefined;
  return typeof output === "string" ? capStr(output) : toBlockText(output);
}
function capStr(s: string, cap = CAP): string {
  return s.length > cap ? `${s.slice(0, cap)}\n… [truncated]` : s;
}

// ── presentational primitives ──

function PathHeader({ path, badge }: { path?: string; badge?: string }) {
  if (!path) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-foreground truncate font-mono text-xs">{path}</span>
      {badge ? (
        <span className="text-muted-foreground shrink-0 text-[0.65rem] uppercase tracking-wide">
          {badge}
        </span>
      ) : null}
    </div>
  );
}

function Mono({ text, tone }: { text: string; tone?: "danger" | "muted" }) {
  return (
    <pre
      className={cn(
        "max-h-72 overflow-auto rounded-md border px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words",
        tone === "danger"
          ? "border-[var(--bv-danger)]/30 bg-[var(--bv-danger)]/5 text-[var(--bv-danger)]"
          : tone === "muted"
            ? "border-border bg-[var(--bv-canvas-soft-2)] text-muted-foreground"
            : "border-border bg-[var(--bv-canvas-soft-2)] text-foreground",
      )}
    >
      {text}
    </pre>
  );
}

function Block({ label, text, tone }: { label: string; text: string; tone?: "danger" }) {
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground text-[0.7rem] font-medium uppercase tracking-wide">
        {label}
      </div>
      <Mono text={text} tone={tone} />
    </div>
  );
}

function Running() {
  return <div className="text-muted-foreground text-xs">Running…</div>;
}

function Terminal({
  command,
  output,
  errored,
  running,
}: {
  command?: string;
  output?: string;
  errored: boolean;
  running: boolean;
}) {
  return (
    <div className="border-border max-h-80 overflow-auto rounded-md border bg-[var(--bv-canvas-soft-2)] font-mono text-xs leading-relaxed">
      {command ? (
        <div className="border-border text-foreground border-b px-3 py-1.5 whitespace-pre-wrap break-words">
          <span className="text-muted-foreground select-none">$ </span>
          {command}
        </div>
      ) : null}
      {output ? (
        <pre
          className={cn(
            "px-3 py-2 whitespace-pre-wrap break-words",
            errored ? "text-[var(--bv-danger)]" : "text-muted-foreground",
          )}
        >
          {output}
        </pre>
      ) : running ? (
        <div className="text-muted-foreground px-3 py-2">Running…</div>
      ) : null}
    </div>
  );
}

const DIFF_MAX_LINES = 240;
const DIFF_MAX_LINE_LEN = 2000;

/** Cap a side of a diff PER SIDE (so additions always show even when removals are
 *  huge), cap each line's length, and append a truncation marker (BRO-1612 P20). */
function diffSide(
  text: string | undefined,
  sign: "+" | "-",
): Array<{ sign: "+" | "-"; t: string }> {
  if (!text) return [];
  const all = text.split("\n");
  const out = all.slice(0, DIFF_MAX_LINES).map((t) => ({
    sign,
    t: t.length > DIFF_MAX_LINE_LEN ? `${t.slice(0, DIFF_MAX_LINE_LEN)}…` : t,
  }));
  if (all.length > DIFF_MAX_LINES) {
    out.push({ sign, t: `… [+${all.length - DIFF_MAX_LINES} more lines]` });
  }
  return out;
}

function DiffBlock({ oldText, newText }: { oldText?: string; newText?: string }) {
  const lines = [...diffSide(oldText, "-"), ...diffSide(newText, "+")];
  if (lines.length === 0) return null;
  return (
    <div className="border-border max-h-72 overflow-auto rounded-md border font-mono text-xs leading-relaxed">
      {lines.map((l, i) => (
        <div
          key={`${l.sign}-${i}-${l.t.slice(0, 24)}`}
          className={cn(
            "flex px-2 whitespace-pre-wrap break-words",
            // green/red are the one place colour is signal (a diff). DS tokens.
            l.sign === "+"
              ? "bg-[color-mix(in_oklch,var(--bv-success)_12%,transparent)] text-[var(--bv-success)]"
              : "bg-[color-mix(in_oklch,var(--bv-danger)_8%,transparent)] text-[var(--bv-danger)]",
          )}
        >
          <span aria-hidden className="select-none pr-2 opacity-60">
            {l.sign}
          </span>
          <span>{l.t || " "}</span>
        </div>
      ))}
    </div>
  );
}

/** Per-tool body — the heart of BRO-1612. */
function ToolBody({
  name,
  input,
  output,
  errored,
  errorText,
  running,
}: {
  name: string;
  input: unknown;
  output: unknown;
  errored: boolean;
  errorText?: string;
  running: boolean;
}) {
  const n = name.toLowerCase();
  const out = outText(output, errored, errorText);

  if (n === "bash" || n === "shell") {
    return (
      <Terminal command={str(input, "command")} output={out} errored={errored} running={running} />
    );
  }

  if (n === "edit") {
    return (
      <div className="space-y-2">
        <PathHeader path={str(input, "file_path")} badge="edit" />
        <DiffBlock oldText={str(input, "old_string")} newText={str(input, "new_string")} />
        {errored && out ? <Block label="Error" text={out} tone="danger" /> : null}
      </div>
    );
  }

  if (n === "multiedit") {
    const editsRaw = (input as { edits?: unknown })?.edits;
    const edits = Array.isArray(editsRaw) ? editsRaw : [];
    const shown = edits.slice(0, 12);
    return (
      <div className="space-y-2">
        <PathHeader
          path={str(input, "file_path")}
          badge={`${edits.length} edit${edits.length === 1 ? "" : "s"}`}
        />
        {shown.map((e, i) => (
          <DiffBlock
            key={`edit-${i}-${(str(e, "old_string") ?? "").slice(0, 24)}`}
            oldText={str(e, "old_string")}
            newText={str(e, "new_string")}
          />
        ))}
        {edits.length > shown.length ? (
          <div className="text-muted-foreground text-xs">
            … +{edits.length - shown.length} more edits
          </div>
        ) : null}
        {errored && out ? <Block label="Error" text={out} tone="danger" /> : null}
      </div>
    );
  }

  if (n === "write") {
    return (
      <div className="space-y-2">
        <PathHeader path={str(input, "file_path")} badge="write" />
        <DiffBlock newText={str(input, "content")} />
        {errored && out ? <Block label="Error" text={out} tone="danger" /> : null}
      </div>
    );
  }

  if (n === "read" || n === "notebookedit") {
    return (
      <div className="space-y-2">
        <PathHeader path={str(input, "file_path")} />
        {out !== undefined ? (
          <Mono text={out} tone={errored ? "danger" : "muted"} />
        ) : running ? (
          <Running />
        ) : null}
      </div>
    );
  }

  if (n === "grep" || n === "glob" || n === "ls") {
    return (
      <div className="space-y-2">
        <PathHeader path={str(input, "pattern") ?? str(input, "path")} />
        {out !== undefined ? (
          <Mono text={out} tone={errored ? "danger" : "muted"} />
        ) : running ? (
          <Running />
        ) : null}
      </div>
    );
  }

  if (n.startsWith("web") || n === "fetch") {
    return (
      <div className="space-y-2">
        <PathHeader path={str(input, "query") ?? str(input, "url")} />
        {out !== undefined ? (
          <Mono text={out} tone={errored ? "danger" : undefined} />
        ) : running ? (
          <Running />
        ) : null}
      </div>
    );
  }

  // default — the generic input + output block (BRO-1607 behavior).
  return (
    <div className="space-y-2.5">
      {input !== undefined ? <Block label="Input" text={toBlockText(input)} /> : null}
      {errored && out ? (
        <Block label="Error" text={out} tone="danger" />
      ) : out !== undefined ? (
        <Block label="Result" text={out} />
      ) : running ? (
        <Running />
      ) : null}
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
      <CollapsibleContent className="px-3 pb-3 pt-1">
        <ToolBody
          name={name}
          input={part.input}
          output={output}
          errored={errored}
          errorText={typeof errorText === "string" ? errorText : undefined}
          running={running}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A skill slug → human label. `kg` → "Kg", `knowledge-graph-memory` →
 *  "Knowledge Graph Memory", `broomva:bookkeeping` → "Bookkeeping" (namespace
 *  dropped — the skill's own name is what reads). Whitespace/case normalized. */
export function humanizeSkill(slug: string): string {
  const base = slug.includes(":") ? slug.slice(slug.lastIndexOf(":") + 1) : slug;
  const words = base
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(" ") || slug.trim();
}

/** Skill activation — a first-class, premium-rendered event, distinct from a
 *  generic tool card (BRO-1625). A skill loads a *capability* into the run, so it
 *  earns a tinted icon chip + humanized name + a status line, with the loaded
 *  content collapsed by default. Mirrors Conductor's "Kg · Skill activated"
 *  treatment in the Genesis DS — a skill is the one place a subtle frost accent
 *  marks a notable event (monochrome-at-rest holds everywhere else). When there's
 *  no captured output the row is non-interactive: just the activation badge. */
export function SkillPart({ part }: { part: AnyToolPart }) {
  const input = part.input as { skill?: unknown; args?: unknown } | undefined;
  const rawSkill = typeof input?.skill === "string" ? input.skill.trim() : "";
  const name = rawSkill ? humanizeSkill(rawSkill) : "Skill";
  const args =
    typeof input?.args === "string" && input.args.trim().length > 0 ? input.args.trim() : undefined;
  const running = part.state === "input-streaming" || part.state === "input-available";
  const errored = part.state === "output-error";
  const output = "output" in part ? part.output : undefined;
  const errorText = "errorText" in part ? part.errorText : undefined;
  const detail = outText(output, errored, typeof errorText === "string" ? errorText : undefined);
  const status = errored ? "Skill failed" : running ? "Activating skill…" : "Skill activated";

  return (
    <Collapsible
      className={cn(
        "group my-2 w-full overflow-hidden rounded-xl border text-left",
        errored
          ? "border-[var(--bv-danger)]/30 bg-[var(--bv-danger)]/5"
          : "border-[var(--bv-blue)]/20 bg-[var(--bv-frost-8)]",
      )}
    >
      <CollapsibleTrigger
        // Non-interactive when there's nothing to expand — still a clean badge row.
        disabled={!detail}
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-2.5 text-left outline-none transition-colors",
          detail
            ? "hover:bg-[var(--bv-frost-12)] focus-visible:ring-2 focus-visible:ring-ring/40"
            : "cursor-default",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-lg",
            errored ? "bg-[var(--bv-danger)]/10" : "bg-[var(--bv-frost-12)]",
          )}
        >
          <SparklesIcon
            className={cn(
              "size-4",
              errored
                ? "text-[var(--bv-danger)]"
                : running
                  ? "text-[var(--bv-blue)]"
                  : "text-[var(--bv-blue-text)]",
            )}
          />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-foreground truncate text-sm font-medium leading-tight">{name}</span>
          <span className="text-muted-foreground text-[0.7rem] font-medium uppercase leading-tight tracking-wide">
            {status}
          </span>
        </span>
        {args ? (
          <span className="text-muted-foreground ml-auto hidden min-w-0 max-w-[42%] truncate font-mono text-xs sm:block">
            {args}
          </span>
        ) : (
          <span className="ml-auto" />
        )}
        {running ? <span className="bv-dot-live shrink-0" aria-label="activating" /> : null}
        {detail ? (
          <ChevronDownIcon
            aria-hidden
            className="text-muted-foreground size-3.5 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180"
          />
        ) : null}
      </CollapsibleTrigger>
      {detail ? (
        <CollapsibleContent className="space-y-2 px-3 pb-3 pt-1">
          {args ? (
            <div className="text-muted-foreground break-words font-mono text-xs sm:hidden">
              {args}
            </div>
          ) : null}
          <Mono text={detail} tone={errored ? "danger" : "muted"} />
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}
