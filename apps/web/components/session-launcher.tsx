"use client";

// The Session Launcher (BRO-1657, Session Launcher phase B slice 3) — an
// Omnara-style pre-session configurator card shown in a NEW thread's empty state.
// It surfaces every sticky binding a thread commits on its first turn in one
// place — "in workspace · start engine · model · effort · on root|worktree" — plus
// starter prompts. The bottom composer stays the single input surface (chat-first
// quick-start preserved); the card is the richer pre-session view that vanishes
// the moment the thread has a message. All controls bind the SAME parent state the
// composer sends, so the card and the composer can never diverge.
//
// The root/worktree toggle is the new control (BRO-1656 gave it a server binding):
// it rides the first `/api/chat` body as `worktree: boolean`, gated on the selected
// workspace's `worktreeCapable` (a global-noWorktree box or a nested-repo workspace
// forces Root). data-testids (BRO-1634) make the whole flow E2E-drivable.

import { ArrowRight, FolderGit2 } from "lucide-react";
import type * as React from "react";

import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Button } from "@/components/ui/button";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ENGINE_OPTIONS,
  type SelectOption,
  WORKTREE_OPTIONS,
  effortOptionsFor,
  engineShowsEffort,
  engineShowsModel,
  modelOptionsFor,
  sanitizeEffortFor,
  sanitizeModelFor,
  sanitizeWorktreeFor,
  workspaceShowsPicker,
} from "@/lib/chat-options";
import { gateEngineOptions } from "@/lib/engines";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/lib/workspaces";

/** A labeled control row inside the card. `label` is the field name; the control
 *  is `children`. Full-width so selects fill the column on mobile. */
function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="text-muted-foreground block text-xs font-medium tracking-wide"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

/** A DS Select filling its column (card fields are stacked, not right-aligned). */
function FieldSelect({
  value,
  options,
  onValueChange,
  ariaLabel,
  testId,
}: {
  value: string;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
  ariaLabel: string;
  testId: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger aria-label={ariaLabel} data-testid={testId} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function SessionLauncher({
  workspace,
  workspaces,
  onWorkspaceChange,
  engine,
  availableEngines,
  onEngineChange,
  model,
  onModelChange,
  effort,
  onEffortChange,
  worktree,
  onWorktreeChange,
  onStart,
  onStarter,
  starters,
}: {
  /** Selected workspace id (BRO-1627) — the repo the new thread will run in. */
  workspace: string;
  workspaces: Workspace[];
  onWorkspaceChange: (value: string) => void;
  /** Selected engine (BRO-1620) — a global pref bound sticky on the first turn. */
  engine: string;
  /** Backend-advertised runnable engines (BRO-1622) — null degrades OPEN. */
  availableEngines: string[] | null;
  onEngineChange: (value: string) => void;
  /** Model + effort (provider-scoped, BRO-1623) — the parent already routes effort
   *  to the right claude/codex slot; the card just displays + changes the value. */
  model: string;
  onModelChange: (value: string) => void;
  effort: string;
  onEffortChange: (value: string) => void;
  /** Root/worktree posture (BRO-1656/1657) — "auto" | "root" | "worktree". */
  worktree: string;
  onWorktreeChange: (value: string) => void;
  /** Focus the composer to begin (lazy: the session is created on the first send,
   *  never before — no ghost threads). */
  onStart: () => void;
  /** Send a starter prompt immediately (same send path as the composer). */
  onStarter: (text: string) => void;
  starters: readonly string[];
}) {
  // Provider-scoped display values (BRO-1623) — a claude alias must never show for
  // codex, nor an OpenAI model for claude; clamp to the selected engine's provider.
  const effModel = sanitizeModelFor(model, engine);
  const effEffort = sanitizeEffortFor(effort, engine);

  const showWorkspace = workspaceShowsPicker(workspaces.length);
  const selectedWorkspace = workspaces.find((w) => w.id === workspace);
  // The selected workspace's worktree capability (BRO-1657): a nested-repo workspace
  // or a global-noWorktree box can't host a worktree → the toggle is forced to Root.
  // Undefined (older engine) → treat as capable; the server still enforces safety.
  const worktreeCapable = selectedWorkspace?.worktreeCapable !== false;
  const effWorktree = sanitizeWorktreeFor(worktree, worktreeCapable);

  const gatedEngines = gateEngineOptions(ENGINE_OPTIONS, availableEngines);

  return (
    <div
      data-testid="session-launcher"
      className="message-in mx-auto flex w-full max-w-md flex-col gap-5 px-1 py-6"
    >
      <div className="space-y-1.5 text-center">
        <p className="text-foreground text-[1.375rem] font-semibold">New session</p>
        <p className="text-muted-foreground text-sm">
          Set how this session runs, then message the agent to start.
        </p>
      </div>

      <div className="border-border bg-[var(--bv-canvas-soft)] space-y-4 rounded-2xl border p-4">
        {showWorkspace ? (
          <Field label="Workspace">
            <Select value={workspace} onValueChange={onWorkspaceChange}>
              <SelectTrigger
                aria-label="Workspace"
                data-testid="launcher-workspace"
                className="w-full"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <FolderGit2 className="text-muted-foreground size-3.5 shrink-0" />
                  <SelectValue />
                </span>
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((w) => (
                  // A vanished workspace (BRO-1630) can't be bound — disable it here
                  // rather than let the user start a dead-on-arrival session.
                  <SelectItem key={w.id} value={w.id} disabled={w.available === false}>
                    {w.name}
                    {w.available === false ? " (unavailable)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        <Field label="Engine">
          <SegmentedControl
            type="single"
            value={engine}
            onValueChange={(v) => v && onEngineChange(v)}
            aria-label="Engine"
            data-testid="launcher-engine"
            className="w-full"
          >
            {gatedEngines.map((o) => (
              <SegmentedControlItem
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                data-testid={`launcher-engine-option-${o.value}`}
                title={o.disabled ? "Not available on this server" : undefined}
                className="flex-1"
              >
                {o.label}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </Field>

        {/* Model + effort follow the engine's provider (BRO-1623); the model row
            hides for a single-model provider (codex → gpt-5.5). */}
        {engineShowsModel(engine) || engineShowsEffort(engine) ? (
          <div
            className={cn(
              "grid gap-3",
              engineShowsModel(engine) && engineShowsEffort(engine) ? "grid-cols-2" : "grid-cols-1",
            )}
          >
            {engineShowsModel(engine) ? (
              <Field label="Model">
                <FieldSelect
                  value={effModel}
                  options={modelOptionsFor(engine)}
                  onValueChange={onModelChange}
                  ariaLabel="Model"
                  testId="launcher-model"
                />
              </Field>
            ) : null}
            {engineShowsEffort(engine) ? (
              <Field label="Effort">
                <FieldSelect
                  value={effEffort}
                  options={effortOptionsFor(engine)}
                  onValueChange={onEffortChange}
                  ariaLabel="Effort"
                  testId="launcher-effort"
                />
              </Field>
            ) : null}
          </div>
        ) : null}

        <Field label="Run in">
          <SegmentedControl
            type="single"
            value={effWorktree}
            onValueChange={(v) => v && onWorktreeChange(v)}
            aria-label="Run in root or a worktree"
            data-testid="launcher-worktree"
            className="w-full"
            disabled={!worktreeCapable}
          >
            {WORKTREE_OPTIONS.map((o) => (
              <SegmentedControlItem
                key={o.value}
                value={o.value}
                // A non-capable workspace forces Root (nested repo / global-noWorktree):
                // keep Root selectable, disable the alternatives so the choice is honest.
                disabled={!worktreeCapable && o.value !== "root"}
                data-testid={`launcher-worktree-option-${o.value}`}
                className="flex-1"
              >
                {o.label}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          <p className="text-muted-foreground text-xs leading-snug">
            {!worktreeCapable
              ? "This workspace runs at its root, so worktrees aren't available here."
              : effWorktree === "worktree"
                ? "Cuts an isolated git worktree for this session."
                : effWorktree === "root"
                  ? "Runs directly in the workspace root."
                  : "Uses the workspace default."}
          </p>
        </Field>
      </div>

      <Button
        type="button"
        onClick={onStart}
        data-testid="launcher-start"
        className="w-full gap-1.5"
        size="lg"
      >
        Start session
        <ArrowRight className="size-4" />
      </Button>

      {starters.length > 0 ? (
        <Suggestions className="justify-center">
          {starters.map((s, i) => (
            <Suggestion
              key={s}
              suggestion={s}
              onClick={onStarter}
              data-testid={`launcher-starter-${i}`}
            />
          ))}
        </Suggestions>
      ) : null}
    </div>
  );
}
