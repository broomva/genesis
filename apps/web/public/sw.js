// Minimal hand-rolled service worker for Genesis PWA.
//
// Strategy:
//   - App shell ("/" + icons + manifest): cache-first, so the app is installable
//     and the shell loads offline.
//   - /api/* (the chat BFF and any future endpoints): NETWORK-ONLY. We never
//     cache or replay a streaming AI-SDK response — a cached SSE stream would be
//     worse than a clear network error.
//   - Everything else (Next static assets): cache-first with background refill.
//
// Serwist (@serwist/next) was considered; the hand-rolled SW is used here to
// keep the Next 16 build clean and the offline behavior explicit. Swapping in
// Serwist later is a contained change (this file + the registration component).

const CACHE = "genesis-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never intercept API traffic — let streaming responses flow straight through.
  if (url.pathname.startsWith("/api/")) return;

  // App-shell navigations: network-first, fall back to cached shell offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/").then((r) => r ?? Response.error())),
    );
    return;
  }

  // Static assets: cache-first, refill in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => cached ?? Response.error());
      return cached ?? network;
    }),
  );
});
