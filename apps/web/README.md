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
GENESIS_URL=http://<engine-host>:8787 bun run start
```

## Testing & dogfooding

Three layers, run in order — each gates the next. (Detailed command blocks for
layers 2–3 live in **Verifying the gate** and **Agent / machine principal**
below.)

**Layer 1 — Automated (CI, every PR).** `.github/workflows/ci.yml` runs on every
push/PR. Run it locally before pushing:

```bash
bun install --frozen-lockfile && bunx biome ci . && bun run typecheck && bun test
```

**Layer 2 — Local pre-deploy gate (the standalone bundle).** Build the *real*
artifact (`output: "standalone"`) and prove the auth gate against it before
deploying — see **Verifying the gate** below. Expected: anon → **401**, valid
`X-Agent-Token` → **200 + stream**, wrong token → **401**, bootstrap → cookie →
chat → **200**.

**Layer 3 — Live dogfood on the VPS (observe + operate).** Deploy, then drive the
live channel while tailing logs. Rebuild + restart after merging a PWA PR:

```bash
ssh agent@<vps> 'export PATH=$HOME/.bun/bin:$PATH; cd ~/genesis && \
  git fetch origin -q && git checkout main -q && git pull -q origin main && \
  bun install --frozen-lockfile && bun run --filter @genesis/web build && \
  cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static && \
  cp -r apps/web/public        apps/web/.next/standalone/apps/web/public && \
  systemctl --user restart genesis-web && systemctl --user is-active genesis-web'
```

Then **observe** (`journalctl --user -u genesis-web -f`) while you **operate** the
authed channel with the agent token (sourced on-box so it never leaves the
server) — see **Agent / machine principal** below. For UI/render changes, also do
a visual check in a real browser (Interceptor) — but the human passkey gate means
the browser needs a signed-in session (WebAuthn user-activation can't be faked
headlessly; a human clicks "Sign in with passkey" once).

### Secrets layout (VPS)

`~/.config/genesis-web/secrets.env` (`0600`, referenced as `EnvironmentFile=` in
the systemd unit):

| Var | Note |
|-----|------|
| `BETTER_AUTH_SECRET` | session/cookie signing (`openssl rand -base64 32`) |
| `BETTER_AUTH_URL` | exact public origin (drives passkey rpID) |
| `AUTH_BOOTSTRAP_TOKEN` | one-time owner creation; spent after first bootstrap |
| `AUTH_DB_PATH` | → `~/.local/share/genesis-web/auth` — **outside the build dir** |
| `AGENT_TOKEN` | machine-principal token for `X-Agent-Token` |

> **Rebuild gotcha:** `next build` wipes `.next/standalone`. Keep `AUTH_DB_PATH`
> **outside** the app tree (e.g. `~/.local/share/genesis-web/auth`) or a rebuild
> erases the owner+passkey and forces a re-bootstrap. The `cp -r` of `.next/static`
> + `public` into the standalone dir is required each rebuild (Next does not bundle
> them).

### Before opening a PWA PR

- [ ] Layer 1 green (`biome ci` · `typecheck` · `bun test` · standalone build emits `server.js`)
- [ ] Layer 2 curl matrix passes on the standalone bundle (gate 401 / agent-token 200 / cookie 200)
- [ ] For UI/render changes: Layer 3 visual check on the live URL after redeploy

> The genesis repo is public — use placeholders (`<vps>`, `<engine-host>`) in docs
> and never commit a token; secrets live only in the `0600` `secrets.env` on the box.

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

### Agent / machine principal (operate + dogfood)

`/api/chat` accepts **two** principals: a human Better Auth session (passkey,
primary) **or** the agent's machine token in the `X-Agent-Token` header
(constant-time compared to `AGENT_TOKEN`). This lets the agent operate and
dogfood the channel without a biometric authenticator. It does **not** weaken
the human gate — a browser never sends `X-Agent-Token`, and the `0600` token is
not held by a random tailnet device. Unset `AGENT_TOKEN` ⇒ the path is disabled
(fail closed).

```bash
# With AGENT_TOKEN set on the server — MUST stream (200), not 401:
curl -sN -X POST https://srv1692698-agent.tailf3e897.ts.net/api/chat \
  -H "X-Agent-Token: $AGENT_TOKEN" -H 'content-type: application/json' \
  -d '{"id":"t","messages":[{"id":"m","role":"user","parts":[{"type":"text","text":"hi"}]}]}'
# a wrong/absent token still returns 401 (gate intact for everyone else)
```

Observe the server while driving it (no app code — over SSH on the VPS):
`journalctl --user -u genesis-web -f` · `systemctl --user status genesis-web` ·
`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/health`.

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
