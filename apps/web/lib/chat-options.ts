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

/** Max context window (tokens) per model selection — the denominator for the
 *  composer context-window meter (BRO-1597). `default` is the opus 1M-context
 *  beta; the explicit aliases run the standard 200k window. */
const MODEL_CONTEXT: Record<string, number> = {
  default: 1_000_000,
  opus: 200_000,
  sonnet: 200_000,
  haiku: 200_000,
  fable: 200_000,
};
const FALLBACK_CONTEXT_WINDOW = 200_000;

/** Context-window size for the selected model value (BRO-1597). */
export function contextWindowFor(model: string): number {
  return MODEL_CONTEXT[model] ?? FALLBACK_CONTEXT_WINDOW;
}

/** Effort picker → claude's native `--effort` enum (low|medium|high|xhigh|max).
 *  `standard` = omit the flag (engine default). All five native levels are
 *  exposed (BRO-1574); thinking only meaningfully engages at xhigh/max under
 *  subscription auth, but the lower levels are valid and passed through verbatim.
 *  NOTE: "ultracode" is NOT a claude `--effort` value (it's a Claude Code session
 *  mode) — claude rejects it and falls back to default, so it is not offered. */
export const EFFORT_OPTIONS: readonly SelectOption[] = [
  { value: "standard", label: "Standard" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
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

/** A persisted value is only honored if it still maps to a known option — a
 *  stale value from a renamed/removed option would leave the controlled Radix
 *  Select with no matching item (blank trigger). */
export function isKnownModel(value: string | null): value is string {
  return value != null && MODEL_OPTIONS.some((o) => o.value === value);
}

export function isKnownEffort(value: string | null): value is string {
  return value != null && EFFORT_OPTIONS.some((o) => o.value === value);
}

/** Agent engine picker (BRO-1620/1621). `interactive` = a persistent Claude Code
 *  session per thread (richer, the exempt subscription class — the default);
 *  `print` = one-shot `claude -p` (metered); `codex` = OpenAI's codex CLI driven
 *  by ChatGPT subscription (BRO-1621), available only when the box has codex
 *  installed + logged in. Sent per turn but the server honors it only on a
 *  thread's FIRST turn (per-thread sticky). Keep these values in sync with the
 *  server's ENGINE_IDS (apps/api channel/types.ts). */
export const ENGINE_OPTIONS: readonly SelectOption[] = [
  { value: "interactive", label: "Interactive" },
  { value: "print", label: "Print" },
  { value: "codex", label: "Codex" },
];
export const DEFAULT_ENGINE = "interactive";

/** Engines that ignore the per-turn model/effort knobs (BRO-1621). The
 *  interactive engine pins them at session spawn; codex reads its own
 *  `~/.codex/config.toml` defaults (its models are auth-tier gated), so the
 *  composer hides the model/effort selectors for both — only `print` honors them. */
const MODELLESS_ENGINES = new Set(["interactive", "codex"]);

/** Whether the composer should surface the per-turn model + effort selectors for
 *  a given engine (only the print engine consumes them). */
export function engineUsesModelControls(engine: string): boolean {
  return !MODELLESS_ENGINES.has(engine);
}

export function isKnownEngine(value: string | null): value is string {
  return value != null && ENGINE_OPTIONS.some((o) => o.value === value);
}

/** Engine rides as a concrete value (no sentinel-omit) — the server binds it
 *  sticky on turn 1, validating against its registry (unknown → its default). */
export function engineToBody(engine: string): string {
  return engine;
}
