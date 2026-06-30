// Theme application (BRO-1618) — lifted out of theme-toggle.tsx so BOTH the
// header quick-toggle and the settings sheet's three-way control drive the same
// mechanism (light / dark / system). Theme is a render-only preference: it flips
// `.dark` on <html>, which drives the CSS-var theme block + Tailwind `dark:`.
//
// Persistence is owned by use-preferences (localStorage genesis:theme + server
// sync); this module is the pure DOM application + the no-flash boot script.

import { type ThemeChoice, isKnownTheme } from "@/lib/preferences";

// localStorage key — read before paint by THEME_INIT_SCRIPT so there is never a
// light↔dark flash. Kept stable (was defined in theme-toggle.tsx).
export const THEME_KEY = "genesis:theme";

/** True iff the OS currently prefers dark. Guarded for SSR (no matchMedia). */
export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Resolve a theme choice to the concrete dark/light boolean. */
export function resolvesDark(theme: ThemeChoice): boolean {
  return theme === "dark" || (theme === "system" && systemPrefersDark());
}

/** Apply a theme choice to <html> NOW (toggles the `.dark` class). */
export function applyTheme(theme: ThemeChoice): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolvesDark(theme));
}

/** Subscribe to OS theme changes — only meaningful while the choice is "system".
 *  Returns an unsubscribe. */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** Read the persisted theme choice (defaults to "light" — the DS signature). */
export function readStoredTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isKnownTheme(v) ? v : "light";
  } catch {
    return "light";
  }
}

// Inline <head> script: apply the stored theme BEFORE first paint (no hydration
// round-trip). Light is the default — only "dark", or "system" while the OS
// prefers dark, adds the class. try/catch so a privacy-mode localStorage throw
// can't blank the page.
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem('${THEME_KEY}');var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d){document.documentElement.classList.add('dark')}}catch(e){}`;
