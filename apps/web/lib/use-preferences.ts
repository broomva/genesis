"use client";

// The ONE source of truth for user preferences on the client (BRO-1618). The
// composer toolbar (model/effort) and the settings sheet (theme/show-reasoning)
// both bind here, so they never drift.
//
// Load order (no-flash + cross-device): read localStorage synchronously on mount
// for an instant render (matches the pre-paint theme script), THEN GET
// /api/settings once and let the server value win — UNLESS the user already
// changed something locally in the cold-load window (the `dirty` guard, P20).
// Every change writes state + localStorage immediately (optimistic) and debounces
// a PUT to the server.

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
  // Latest committed prefs — read by `update` so rapid successive calls compose
  // off the freshest value without a side-effecting setState updater (P20 #3).
  const prefsRef = useRef<Preferences>(DEFAULT_PREFERENCES);
  // The user changed something locally → the one-shot server GET must NOT clobber
  // it (P20 #1). Their change is the truth; the debounced PUT ships it.
  const dirty = useRef(false);
  const putTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const commit = useCallback((next: Preferences, applyThemeToo: boolean) => {
    prefsRef.current = next;
    setPrefs(next);
    writeLocal(next);
    if (applyThemeToo) applyTheme(next.theme);
  }, []);

  // 1. localStorage → instant render (the pre-paint script already applied theme).
  useEffect(() => {
    commit(readLocal(), true);
    setReady(true);
  }, [commit]);

  // 2. Server wins (cross-device) — but only if the user hasn't already edited in
  //    the cold-load window. One GET after the local read settles.
  useEffect(() => {
    if (!ready) return;
    const ctrl = new AbortController();
    fetch("/api/settings", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((server) => {
        if (!server || dirty.current) return; // user already changed something → keep it
        commit(sanitizePreferences(server), true);
      })
      .catch(() => {
        // offline / unauthorized — localStorage already drives the UI.
      });
    return () => ctrl.abort();
  }, [ready, commit]);

  // 3. Track OS theme while the choice is "system" (keeps the DOM class in sync).
  useEffect(() => {
    if (prefs.theme !== "system") return;
    return watchSystemTheme(() => applyTheme("system"));
  }, [prefs.theme]);

  // 4. Flush the pending PUT timer on unmount (cosmetic — the page-level hook
  //    rarely unmounts, but avoids a dangling timer in dev/HMR).
  useEffect(() => {
    return () => {
      if (putTimer.current) clearTimeout(putTimer.current);
    };
  }, []);

  const update = useCallback(
    (partial: Partial<Preferences>) => {
      const next = sanitizePreferences({ ...prefsRef.current, ...partial });
      dirty.current = true;
      commit(next, "theme" in partial);
      if (putTimer.current) clearTimeout(putTimer.current);
      putTimer.current = setTimeout(() => {
        void fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        }).catch(() => {});
      }, 400);
    },
    [commit],
  );

  return { prefs, ready, update };
}
