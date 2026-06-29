"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useRef, useState } from "react";

// Human-in-the-loop answer cards (BRO-1611). The agent's AskUserQuestion arrives
// as a tool part carrying `input.questions`; we render each question + its options
// as selectable cards. Answers are aggregated ACROSS the whole card and sent as a
// SINGLE turn (BRO-1611 P20 fix: claude batches up to ~4 questions per call, so a
// per-question send abandoned every question after the first). The agent resumes
// via --resume and reads the combined answer. The composer stays usable, so
// free-text answers always work; the cards are an affordance, not a modal.

export type QuestionOption = { label: string; description?: string };
export type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: QuestionOption[];
};

/** Defensively parse the AskUserQuestion tool input into questions. */
export function asQuestions(input: unknown): Question[] {
  if (!input || typeof input !== "object") return [];
  const qs = (input as { questions?: unknown }).questions;
  if (!Array.isArray(qs)) return [];
  return qs.filter(
    (q): q is Question =>
      !!q && typeof q === "object" && typeof (q as Question).question === "string",
  );
}

/** Build the single combined answer text the agent receives (BRO-1611). One
 *  question → just the answer; many → "Header: answer" lines so the mapping is
 *  unambiguous on --resume. */
export function combineAnswers(questions: Question[], answers: Record<number, string[]>): string {
  if (questions.length === 1) return (answers[0] ?? []).join(", ");
  return questions
    .map((q, i) => `${q.header ?? q.question}: ${(answers[i] ?? []).join(", ")}`)
    .join("\n");
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
  const [answers, setAnswers] = useState<Record<number, string[]>>({});
  const sent = useRef(false);

  if (questions.length === 0) return null;

  // One single-select question = the common case → click an option to send in one
  // tap. Otherwise aggregate across the card behind an explicit Send.
  const oneShot = questions.length === 1 && questions[0].multiSelect !== true;

  const send = (text: string) => {
    if (!interactive || sent.current || !text.trim()) return;
    sent.current = true; // guards rapid double-clicks → never two turns
    onAnswer(text);
  };

  const toggle = (qi: number, label: string, multi: boolean) => {
    if (!interactive) return;
    if (oneShot) {
      send(label);
      return;
    }
    setAnswers((a) => {
      const cur = a[qi] ?? [];
      if (multi) {
        return {
          ...a,
          [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
        };
      }
      return { ...a, [qi]: [label] }; // single-select within a multi-question card
    });
  };

  const allAnswered = questions.every((_, qi) => (answers[qi]?.length ?? 0) > 0);

  return (
    <div className="my-2 flex flex-col gap-2">
      {questions.map((q, qi) => (
        <SingleQuestion
          key={`${q.header ?? "q"}-${qi}`}
          q={q}
          qi={qi}
          interactive={interactive}
          selected={answers[qi] ?? []}
          onToggle={toggle}
        />
      ))}
      {!oneShot && interactive ? (
        <Button
          type="button"
          size="sm"
          className="self-end"
          disabled={!allAnswered}
          onClick={() => send(combineAnswers(questions, answers))}
        >
          Send
        </Button>
      ) : null}
    </div>
  );
}

function SingleQuestion({
  q,
  qi,
  interactive,
  selected,
  onToggle,
}: {
  q: Question;
  qi: number;
  interactive: boolean;
  selected: string[];
  onToggle: (qi: number, label: string, multi: boolean) => void;
}) {
  const options = q.options ?? [];
  const multi = q.multiSelect === true;
  return (
    <div className="border-border bg-[var(--bv-canvas-soft-2)] rounded-xl border p-3">
      {q.header ? (
        <div className="text-muted-foreground text-[0.7rem] font-medium uppercase tracking-wide">
          {q.header}
        </div>
      ) : null}
      <div className="text-foreground mt-0.5 text-sm font-medium" id={`q-${qi}`}>
        {q.question}
      </div>

      {options.length > 0 ? (
        <div
          // biome-ignore lint/a11y/useSemanticElements: a button group, not a list
          role="group"
          aria-labelledby={`q-${qi}`}
          className="mt-2.5 flex flex-col gap-1.5"
        >
          {options.map((o, oi) => {
            const on = selected.includes(o.label);
            return (
              <button
                key={`${o.label}-${oi}`}
                type="button"
                onClick={() => onToggle(qi, o.label, multi)}
                disabled={!interactive}
                aria-pressed={on}
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
        </div>
      ) : interactive ? (
        <div className="text-muted-foreground mt-2 text-xs">Type your answer below.</div>
      ) : null}
    </div>
  );
}
