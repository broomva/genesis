"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useState } from "react";

// Human-in-the-loop answer cards (BRO-1611). The agent's AskUserQuestion arrives
// as a tool part carrying `input.questions`; we render each question + its options
// as selectable cards. Single-select sends on click; multi-select toggles + a
// Send button. Answering posts the chosen label(s) as the next turn (the agent
// resumes via --resume). Non-interactive once it's no longer the awaiting turn —
// historical questions render as a static record. The composer stays usable, so
// free-text answers always work; the cards are an affordance, not a modal.

type Opt = { label: string; description?: string };
type Q = { question: string; header?: string; multiSelect?: boolean; options?: Opt[] };

function asQuestions(input: unknown): Q[] {
  if (!input || typeof input !== "object") return [];
  const qs = (input as { questions?: unknown }).questions;
  if (!Array.isArray(qs)) return [];
  return qs.filter(
    (q): q is Q => !!q && typeof q === "object" && typeof (q as Q).question === "string",
  );
}

export function QuestionCard({
  input,
  interactive,
  onAnswer,
}: {
  input: unknown;
  interactive: boolean;
  onAnswer: (text: string) => void;
}) {
  const questions = asQuestions(input);
  if (questions.length === 0) return null;
  return (
    <div className="my-2 flex flex-col gap-2">
      {questions.map((q, i) => (
        <SingleQuestion
          key={`${q.header ?? "q"}-${i}`}
          q={q}
          interactive={interactive}
          onAnswer={onAnswer}
        />
      ))}
    </div>
  );
}

function SingleQuestion({
  q,
  interactive,
  onAnswer,
}: {
  q: Q;
  interactive: boolean;
  onAnswer: (text: string) => void;
}) {
  const options = q.options ?? [];
  const multi = q.multiSelect === true;
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const pick = (label: string) => {
    if (!interactive) return;
    if (multi) {
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(label)) next.delete(label);
        else next.add(label);
        return next;
      });
    } else {
      onAnswer(label);
    }
  };

  return (
    <div className="border-border bg-[var(--bv-canvas-soft-2)] rounded-xl border p-3">
      {q.header ? (
        <div className="text-muted-foreground text-[0.7rem] font-medium uppercase tracking-wide">
          {q.header}
        </div>
      ) : null}
      <div className="text-foreground mt-0.5 text-sm font-medium">{q.question}</div>

      {options.length > 0 ? (
        <div className="mt-2.5 flex flex-col gap-1.5">
          {options.map((o) => {
            const on = selected.has(o.label);
            return (
              <button
                key={o.label}
                type="button"
                onClick={() => pick(o.label)}
                disabled={!interactive}
                aria-pressed={multi ? on : undefined}
                className={cn(
                  "flex w-full flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  on
                    ? "border-[var(--bv-blue)] bg-[color-mix(in_oklch,var(--bv-blue)_10%,transparent)]"
                    : "border-border hover:border-[color-mix(in_oklch,var(--bv-blue)_50%,transparent)] hover:bg-[var(--bv-frost-8)]",
                  !interactive && "cursor-default opacity-70",
                )}
              >
                <span className="text-foreground text-sm">{o.label}</span>
                {o.description ? (
                  <span className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                    {o.description}
                  </span>
                ) : null}
              </button>
            );
          })}
          {multi && interactive ? (
            <Button
              type="button"
              size="sm"
              className="mt-1 self-end"
              disabled={selected.size === 0}
              onClick={() => selected.size > 0 && onAnswer([...selected].join(", "))}
            >
              {selected.size > 0 ? `Send ${selected.size}` : "Send"}
            </Button>
          ) : null}
        </div>
      ) : interactive ? (
        <div className="text-muted-foreground mt-2 text-xs">Type your answer below.</div>
      ) : null}
    </div>
  );
}
