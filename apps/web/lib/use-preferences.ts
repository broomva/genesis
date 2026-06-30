"use client";

// The ONE source of truth for user preferences on the client (BRO-1618). The
// composer toolbar (model/effort) and the settings sheet (theme/show-reasoning)
// both bind here, so they never drift.
//
// Load order (no-flash + cross-device): read localStorage synchronously on mount
// for an instant render (matches the pre-paint theme script), THEN GET
// /api/settings once and let the server value win (cross-device truth). Every
// change writes state + localStorage immediately (optimistic) and debounces a
// PUT to the server.

import { useCallback, useEffect, useRef, useState } from "react";

import { DEFAULT_PREFERENCES, type Preferences, sanitizePreferences } from "@/lib/preferences";
import { THEME_KEY, applyTheme, watchSystemTheme } from "@/lib/theme";

const MODEL_KEY = "genesis:model";
const EFFORT_KEY = "genesis:effort";
const SHOW_REASONING_KEY = "genesis:show-reasoning";

function writeLocal(p: Preferences): void {
  try {
    localStorage.setItem(MODEL_KEY, p.model);
    localStorage.setItem(EFFORT_KEY, p.effort);
    localStorage.setItem(THEME_KEY, p.theme);
    localStorage.setItem(SHOW_REASONING_KEY, String(p.showReasoning));
  } catch {
    // private mode — state still drives this session.
  }
}

function readLocal(): Preferences {
  try {
    const sr = localStorage.getItem(SHOW_REASONING_KEY);
    return sanitizePreferences({
      model: localStorage.getItem(MODEL_KEY),
      effort: localStorage.getItem(EFFORT_KEY),
      theme: localStorage.getItem(THEME_KEY),
      showReasoning: sr === null ? undefined : sr === "true",
    });
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export interface UsePreferences {
  prefs: Preferences;
  /** True once localStorage has been read (so consumers can avoid a default flash). */
  ready: boolean;
  /** Merge a partial change: optimistic local + debounced server sync. */
  update: (partial: Partial<Preferences>) => void;
}

export function usePreferences(): UsePreferences {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [ready, setReady] = useState(false);
  const putTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 1. localStorage → instant render (the pre-paint script already applied theme).
  useEffect(() => {
    const local = readLocal();
    setPrefs(local);
    applyTheme(local.theme);
    setReady(true);
  }, []);

  // 2. Server wins (cross-device). One GET after the local read settles.
  useEffect(() => {
    if (!ready) return;
    const ctrl = new AbortController();
    fetch("/api/settings", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((server) => {
        if (!server) return;
        const next = sanitizePreferences(server);
        setPrefs(next);
        writeLocal(next);
        applyTheme(next.theme);
      })
      .catch(() => {
        // offline / unauthorized — localStorage already drives the UI.
      });
    return () => ctrl.abort();
  }, [ready]);

  // 3. Track OS theme while the choice is "system".
  useEffect(() => {
    if (prefs.theme !== "system") return;
    return watchSystemTheme(() => applyTheme("system"));
  }, [prefs.theme]);

  const update = useCallback((partial: Partial<Preferences>) => {
    setPrefs((prev) => {
      const next = sanitizePreferences({ ...prev, ...partial });
      writeLocal(next);
      if ("theme" in partial) applyTheme(next.theme);
      if (putTimer.current) clearTimeout(putTimer.current);
      putTimer.current = setTimeout(() => {
        void fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        }).catch(() => {});
      }, 400);
      return next;
    });
  }, []);

  return { prefs, ready, update };
}
