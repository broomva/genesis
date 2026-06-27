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

## Auth — single-user passkey gate

A **single-user** auth gate built on **Better Auth** (`better-auth@1.6.x`) with
the **passkey/WebAuthn** plugin (`@better-auth/passkey@1.6.x`). No passwords, no
email, no social — passkey-primary.

### Pieces

| File | Role |
|------|------|
| `lib/auth.ts` | `betterAuth({...})` — pglite (Drizzle adapter) store, passkey plugin, **closed email/password signup** |
| `lib/auth-schema.ts` | Explicit Drizzle schema + `CREATE TABLE IF NOT EXISTS` DDL run on first request |
| `lib/auth-client.ts` | Browser client (`createAuthClient` + `passkeyClient`) |
| `app/api/auth/[...all]/route.ts` | Better Auth Next handler (`toNextJsHandler`) — mounts `/api/auth/*` |
| `app/api/auth/bootstrap/route.ts` | One-time owner creation, token-gated (the security crux) |
| `app/api/chat/route.ts` | Gated: `auth.api.getSession` → 401 if no session (real enforcement) |
| `middleware.ts` | Optimistic cookie check (`getSessionCookie`) → redirect page routes to `/login` |
| `app/login/page.tsx` | Passkey sign-in + first-run bootstrap UI |

### Env

Set these (see `.env.example`):

- `BETTER_AUTH_SECRET` — random 32+ char signing secret (`openssl rand -base64 32`). Required.
- `BETTER_AUTH_URL` — exact public origin (drives the passkey rpID + baseURL), e.g. `https://srv1692698-agent.tailf3e897.ts.net`.
- `AUTH_BOOTSTRAP_TOKEN` — one-time owner-creation token. **MUST be high-entropy** (`openssl rand -base64 32`): this custom route is not behind Better Auth's rate limiter, so a weak token is brute-forceable in the pre-owner window. **Keep secret.** If unset, bootstrap is disabled (fail closed). The window closes the instant the owner is created (later requests 409).
- `AUTH_DB_PATH` — auth pglite dir (default `./.data/auth`, separate from the engine store).
- `AUTH_OWNER_EMAIL` — optional; pins the owner email (cosmetic, single-user). Default `owner@genesis.local`.

### Closed signup + the bootstrap crux

Open registration is **disabled** (`emailAndPassword.enabled = false`), so there
is no public path to create a user. The single owner is created exactly once via
`POST /api/auth/bootstrap`, which requires **both**:

1. the correct `AUTH_BOOTSTRAP_TOKEN` (constant-time compared) — a tailnet
   device that can reach the URL but lacks the token gets **401**; and
2. **zero existing users** — after the owner exists the route returns **409**
   and the door is sealed permanently.

On success it creates the owner *and* an authenticated session (sets the signed
`better-auth.session_token` cookie). Passkey enrollment itself requires a session
(`registration.requireSession` defaults to `true`), so there is **no path** for
an unauthenticated, tokenless caller to register a credential.

### First-run flow (bootstrap → enroll)

1. Deploy with `AUTH_BOOTSTRAP_TOKEN` set.
2. Open `/login` → "First run? Set up the owner" → paste the token →
   "Create owner + enroll passkey".
3. The page calls `POST /api/auth/bootstrap` (creates the owner + session), then
   immediately `authClient.passkey.addPasskey()` to enroll **this device's
   passkey** (Touch ID / Windows Hello / security key). Redirects to `/`.
4. Thereafter: `/login` → "Sign in with passkey" (`authClient.signIn.passkey()`).

> Passkey enroll/sign-in need a real platform authenticator (WebAuthn), so they
> are **deploy-verified** in a browser — they cannot be exercised in headless CI.
> The automated gate (401 on `/api/chat` with no session, auth endpoints mount,
> token-gated bootstrap) IS covered (see below).

### pglite + standalone

`@electric-sql/pglite` is pure-JS/WASM (no native deps) so it is safe with
`output: "standalone"`. `next.config.ts` lists `@electric-sql/pglite`,
`better-auth`, `@better-auth/passkey` in `serverExternalPackages` so the bundler
does not inline the WASM and the files are traced into `.next/standalone`. The
pglite client is constructed **lazily on first request** (not at module load),
so `next build` static generation never touches the WASM.

### Verifying the gate (no WebAuthn needed)

```bash
bun run build && (cd .next/standalone/apps/web && \
  cp -r ../../../.next/static .next/static && cp -r ../../../public public && \
  GENESIS_URL=http://100.82.195.109:8787 \
  BETTER_AUTH_SECRET=test-secret-please-change-32chars \
  BETTER_AUTH_URL=http://localhost:3000 AUTH_BOOTSTRAP_TOKEN=test-boot \
  node server.js)

# In another shell — MUST print 401:
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/chat \
  -H 'content-type: application/json' \
  -d '{"id":"t","messages":[{"id":"m","role":"user","parts":[{"type":"text","text":"hi"}]}]}'
# → 401

curl -s http://localhost:3000/api/auth/ok   # → {"ok":true}  (handler mounted)
```

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
