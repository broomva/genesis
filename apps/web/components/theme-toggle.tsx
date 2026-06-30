"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { ThemeChoice } from "@/lib/preferences";
import { resolvesDark, watchSystemTheme } from "@/lib/theme";

// Header quick-toggle for theme (BRO-1618). CONTROLLED by the prefs hook so it
// never drifts from the settings sheet's three-way control; the heavy lifting
// (apply `.dark`, persist, server-sync) lives in use-preferences + lib/theme.
// Toggling sets an EXPLICIT light/dark — "system" is reachable only via Settings.
// The no-flash boot script + the THEME_KEY now live in lib/theme.ts.
export function ThemeToggle({
  theme,
  onChange,
}: {
  theme: ThemeChoice;
  onChange: (theme: ThemeChoice) => void;
}) {
  // Guard SSR↔hydration: `resolvesDark("system")` reads matchMedia (client-only),
  // so render a neutral placeholder until mounted to avoid a Sun↔Moon mismatch.
  const [mounted, setMounted] = useState(false);
  // Re-render the icon when the OS theme flips while the choice is "system"
  // (resolvesDark("system") reads matchMedia, which doesn't trigger React) — P20 #2.
  const [, bump] = useState(0);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (theme !== "system") return;
    return watchSystemTheme(() => bump((n) => n + 1));
  }, [theme]);
  const isDark = mounted && resolvesDark(theme);

  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      onClick={() => onChange(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title="Toggle theme"
      className="[@media(pointer:coarse)]:size-11"
    >
      {!mounted ? (
        <span className="size-4" aria-hidden />
      ) : isDark ? (
        <Moon className="size-4" />
      ) : (
        <Sun className="size-4" />
      )}
    </Button>
  );
}
