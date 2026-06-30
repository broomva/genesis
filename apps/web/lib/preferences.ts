// Shared user-preferences schema (BRO-1618) — the single source of truth for
// what a Genesis user can configure. PURE + isomorphic (no DOM, no db, no
// server-only imports) so both the client hook (use-preferences) and the server
// store (preferences-store) import the SAME type, defaults, and validator.
//
// Two preference classes (the mechanical rule from the subsystem map):
//   • agent-affecting (model, effort) — ride to the engine per turn; the option
//     lists + validators live in chat-options.ts (reused here, never duplicated).
//   • render-only (theme, showReasoning) — change how the client renders; never
//     sent to the engine.

import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  type SelectOption,
  isKnownEffort,
  isKnownModel,
} from "@/lib/chat-options";

/** Theme choice — light/dark are explicit; system follows the OS
 *  prefers-color-scheme. Light leads (the DS signature look). */
export type ThemeChoice = "light" | "dark" | "system";

export const THEME_OPTIONS: readonly SelectOption[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export const DEFAULT_THEME: ThemeChoice = "light";

export function isKnownTheme(value: unknown): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

/** Everything a user can configure. Agent-affecting (model/effort) + render-only
 *  (theme/showReasoning). Engine selection (BRO-1620) lands here later. */
export interface Preferences {
  model: string;
  effort: string;
  theme: ThemeChoice;
  /** Render-gate for the reasoning ("Reasoned") panel (BRO-1614/1616). */
  showReasoning: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
  theme: DEFAULT_THEME,
  showReasoning: true,
};

/** Coerce ANY untrusted shape (localStorage blob, server JSON, partial PUT body)
 *  into a complete, valid Preferences — every field validated, unknown/stale
 *  values replaced by the default. A renamed/removed model option must never
 *  leave a controlled Radix Select blank, so model/effort go through the
 *  chat-options validators. */
export function sanitizePreferences(raw: unknown): Preferences {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const model = typeof o.model === "string" && isKnownModel(o.model) ? o.model : DEFAULT_MODEL;
  const effort =
    typeof o.effort === "string" && isKnownEffort(o.effort) ? o.effort : DEFAULT_EFFORT;
  const theme = isKnownTheme(o.theme) ? o.theme : DEFAULT_THEME;
  const showReasoning = typeof o.showReasoning === "boolean" ? o.showReasoning : true;
  return { model, effort, theme, showReasoning };
}
