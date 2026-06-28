// Per-turn chat controls (BRO-1573) — model + effort selectors surfaced in the
// PromptInput toolbar. The selected values ride to the engine as top-level body
// fields on each `sendMessage(_, { body })`.
//
// Radix Select forbids an empty-string item value, so the "use the engine
// default" choice carries a sentinel ("default"/"standard") that maps to
// `undefined` (omit the flag) before it reaches the wire.

export interface SelectOption {
  value: string;
  label: string;
}

/** Model picker. `default` = omit `--model` → the engine default
 *  (claude-opus-4-8 with the 1M-context beta). Aliases resolve on the box:
 *  opus→4.8, sonnet→4.6, haiku→4.5, fable→5. */
export const MODEL_OPTIONS: readonly SelectOption[] = [
  { value: "default", label: "Opus · 1M" },
  { value: "opus", label: "Opus 4.8" },
  { value: "sonnet", label: "Sonnet 4.6" },
  { value: "haiku", label: "Haiku 4.5" },
  { value: "fable", label: "Fable 5" },
];
export const DEFAULT_MODEL = "default";

/** Effort picker → claude `--effort`. `standard` = omit the flag. Thinking only
 *  meaningfully engages at xhigh/max under subscription auth (BRO-1573 research),
 *  so the two non-default steps map there. */
export const EFFORT_OPTIONS: readonly SelectOption[] = [
  { value: "standard", label: "Standard" },
  { value: "xhigh", label: "Extended" },
  { value: "max", label: "Max" },
];
export const DEFAULT_EFFORT = "standard";

/** Map the model selection to the wire value (sentinel → omit). */
export function modelToBody(model: string): string | undefined {
  return model === "default" ? undefined : model;
}

/** Map the effort selection to the wire value (sentinel → omit). */
export function effortToBody(effort: string): string | undefined {
  return effort === DEFAULT_EFFORT ? undefined : effort;
}
