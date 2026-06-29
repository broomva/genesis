"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

// localStorage key — the chosen theme survives reloads. Read once before paint by
// the no-flash script in layout.tsx (THEME_INIT_SCRIPT), so there is never a
// light→dark flash. Default is light (the DS signature look).
export const THEME_KEY = "genesis:theme";

// Inline <head> script: apply the stored theme to <html> BEFORE first paint.
// Light is the default — only the explicit "dark" choice adds the class. Kept as
// a string so it can run synchronously via dangerouslySetInnerHTML (no hydration
// round-trip). Wrapped in try/catch so a privacy-mode localStorage throw can't
// blank the page.
export const THEME_INIT_SCRIPT = `try{if(localStorage.getItem('${THEME_KEY}')==='dark'){document.documentElement.classList.add('dark')}}catch(e){}`;

/** Light/dark toggle. The DS fully specifies both; light leads (its "reads as
 *  Houston until you look" signature lives there). Toggling flips `.dark` on
 *  <html> — which drives both the CSS-var theme block and Tailwind `dark:`
 *  utilities — and persists the choice. */
export function ThemeToggle() {
  // null until mounted — the trigger renders a stable placeholder during SSR so
  // the icon doesn't mismatch the (script-applied) class on hydration.
  const [isDark, setIsDark] = useState<boolean | null>(null);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(THEME_KEY, next ? "dark" : "light");
    } catch {
      // private mode — the toggle still works for this session.
    }
    setIsDark(next);
  }

  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title="Toggle theme"
      className="[@media(pointer:coarse)]:size-11"
    >
      {/* While `isDark` is null (SSR + first client render, before the effect
          reads the script-applied class) show a neutral placeholder — never the
          wrong icon. This matches SSR↔hydration and avoids a Moon→Sun flash. */}
      {isDark === null ? (
        <span className="size-4" aria-hidden />
      ) : isDark ? (
        <Moon className="size-4" />
      ) : (
        <Sun className="size-4" />
      )}
    </Button>
  );
}
