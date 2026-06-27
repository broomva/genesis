"use client";

import { useEffect } from "react";

// Registers the hand-rolled service worker (public/sw.js) for PWA
// installability + offline app-shell. Registration is best-effort and silent on
// failure — a missing SW must never break the app. Skipped in dev to avoid
// caching the HMR runtime.
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  return null;
}
