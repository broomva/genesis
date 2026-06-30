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
/** codex's default model (gpt-5.5) context window — approximate denominator for
 *  the meter on codex threads (BRO-1623). The meter is informational. */
const CODEX_CONTEXT_WINDOW = 400_000;

/** Context-window size for the selected model value (BRO-1597/1623). Engine-aware:
 *  the same sentinel "default" means Opus-1M on a claude engine but gpt-5.5 on
 *  codex, so the provider decides before the per-model lookup. */
export function contextWindowFor(model: string, engine?: string): number {
  if (engine && engineProvider(engine) === "openai") return CODEX_CONTEXT_WINDOW;
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

/** A persisted value is only honored if it maps to a known option for EITHER
 *  provider (BRO-1623) — the model/effort prefs are a shared slot across engines,
 *  so a valid codex value (e.g. effort "minimal") must survive a reload even
 *  though it isn't a claude option. The composer/settings then clamp it to the
 *  active engine's provider via {@link sanitizeModelFor}/{@link sanitizeEffortFor}.
 *  A genuinely unknown value (renamed/removed) is still dropped → provider default. */
export function isKnownModel(value: string | null): value is string {
  return (
    value != null &&
    (MODEL_OPTIONS.some((o) => o.value === value) ||
      CODEX_MODEL_OPTIONS.some((o) => o.value === value))
  );
}

export function isKnownEffort(value: string | null): value is string {
  return (
    value != null &&
    (EFFORT_OPTIONS.some((o) => o.value === value) ||
      CODEX_EFFORT_OPTIONS.some((o) => o.value === value))
  );
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

export function isKnownEngine(value: string | null): value is string {
  return value != null && ENGINE_OPTIONS.some((o) => o.value === value);
}

// ── Provider-aware model/effort (BRO-1623) ──────────────────────────────────
// Each engine belongs to a provider, and the model/effort options + wiring must
// match it: a claude alias must never reach codex, nor an OpenAI model claude.
//   print        → Anthropic, per-turn model + effort
//   interactive  → Anthropic, model at SPAWN (locked once running), no effort
//   codex        → OpenAI, per-turn model + reasoning effort

export type EngineProvider = "anthropic" | "openai";

/** The LLM provider behind an engine. */
export function engineProvider(engine: string): EngineProvider {
  return engine === "codex" ? "openai" : "anthropic";
}

/** OpenAI model picker for codex (BRO-1623). Only models the ChatGPT
 *  subscription actually serves are offered — gpt-5.5 is the default and the
 *  only one verified available (gpt-5.5-codex / gpt-5.1-codex 400 on this tier);
 *  `default` omits `-m` so codex uses its config default (gpt-5.5). Add entries
 *  here as higher tiers expose more models. */
export const CODEX_MODEL_OPTIONS: readonly SelectOption[] = [
  { value: "default", label: "GPT-5.5" },
];

/** codex reasoning-effort picker → `-c model_reasoning_effort` (BRO-1623).
 *  `standard` omits the override (codex config default). `minimal` is codex-only. */
export const CODEX_EFFORT_OPTIONS: readonly SelectOption[] = [
  { value: "standard", label: "Default" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/** The model options for an engine's provider (claude aliases vs OpenAI models). */
export function modelOptionsFor(engine: string): readonly SelectOption[] {
  return engineProvider(engine) === "openai" ? CODEX_MODEL_OPTIONS : MODEL_OPTIONS;
}

/** The effort options for an engine's provider. */
export function effortOptionsFor(engine: string): readonly SelectOption[] {
  return engineProvider(engine) === "openai" ? CODEX_EFFORT_OPTIONS : EFFORT_OPTIONS;
}

/** Provider default model/effort sentinels (both "omit the flag"). */
export function defaultModelFor(_engine: string): string {
  return DEFAULT_MODEL; // "default" — claude Opus-1M or codex gpt-5.5 per provider
}
export function defaultEffortFor(_engine: string): string {
  return DEFAULT_EFFORT; // "standard" — omit the effort override
}

/** Whether the composer shows the model selector for an engine. All three do —
 *  but interactive's binds at spawn (see {@link modelIsSpawnPinned}). */
export function engineShowsModel(_engine: string): boolean {
  return true;
}

/** Whether the composer shows the effort selector. Interactive has no clean
 *  per-launch effort knob (persistent claude session) → hidden there. */
export function engineShowsEffort(engine: string): boolean {
  return engine !== "interactive";
}

/** True when the model binds at session SPAWN rather than per-turn (interactive):
 *  the selector is editable only until the thread's session exists, then locks. */
export function modelIsSpawnPinned(engine: string): boolean {
  return engine === "interactive";
}

/** Clamp a stored model pref to a value valid for the engine's provider — so a
 *  claude alias held in the shared pref slot can't be sent to (or shown for)
 *  codex, and vice-versa. Falls back to the provider default. */
export function sanitizeModelFor(model: string, engine: string): string {
  return modelOptionsFor(engine).some((o) => o.value === model) ? model : defaultModelFor(engine);
}

/** Clamp a stored effort pref to a value valid for the engine's provider. */
export function sanitizeEffortFor(effort: string, engine: string): string {
  return effortOptionsFor(engine).some((o) => o.value === effort)
    ? effort
    : defaultEffortFor(engine);
}

/** Engine rides as a concrete value (no sentinel-omit) — the server binds it
 *  sticky on turn 1, validating against its registry (unknown → its default). */
export function engineToBody(engine: string): string {
  return engine;
}
