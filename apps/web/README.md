# @genesis/web

A Next.js (App Router, TypeScript, Tailwind v4) **PWA chat client** for the
genesis agent engine. It drives the engine's `/api/chat` endpoint via the Vercel
AI SDK (`useChat` + `DefaultChatTransport`) and renders the conversation with
shadcn's June-2026 chat-interface components (`MessageScroller`, `Message`,
`Bubble`, `Marker`, `Attachment`).

## Dev

```bash
# point at a running genesis engine (local default is http://127.0.0.1:8787)
GENESIS_URL=http://100.82.195.109:8787 bun run dev
```

Then open http://localhost:3000. Type a message; the response streams in.

Build + run the production server:

```bash
bun run build
GENESIS_URL=http://100.82.195.109:8787 bun run start
```

## What the BFF does

`app/api/chat/route.ts` is a thin **back-end-for-front-end proxy**:

- reads `GENESIS_URL` (default `http://127.0.0.1:8787`) and optional
  `GENESIS_TOKEN` from server-only env,
- forwards the incoming AI-SDK request body verbatim to
  `${GENESIS_URL}/api/chat`, injecting `Authorization: Bearer ${GENESIS_TOKEN}`
  when the token is set,
- **streams the upstream response back untouched** (`new Response(upstream.body, …)`,
  never buffered) so the AI SDK UI-message-stream protocol flows straight to the
  browser.

The browser only ever talks to same-origin `/api/chat`; the upstream URL and
token stay on the server.

## Auth (next PR)

Auth is intentionally **out of scope** for this slice. The clean seam is the
`Authorization` header line in `app/api/chat/route.ts`: a later PR wires Better
Auth + passkey and resolves the per-user token from the session there, swapping
it in at that exact point. Nothing in the UI assumes anonymous access.

## PWA

- `app/manifest.ts` → installable manifest (`display: standalone`, brand colors).
- `public/sw.js` → hand-rolled service worker (app-shell cache-first; `/api/*`
  never cached — streaming responses pass straight through), registered from
  `components/service-worker.tsx` in production only.

> Serwist (`@serwist/next`) was considered but the hand-rolled SW keeps the
> Next 16 build clean and the offline policy explicit. Swapping it in later is a
> contained change (that file + the registration component).

## Stack notes

- Package manager: **bun**. Linter/formatter: **Biome** (no ESLint).
- `ai@6.0.213` + `@ai-sdk/react@3.0.215` (the AI-SDK v6 line).
- `next.config.ts` sets `output: "standalone"` for container deploys.
