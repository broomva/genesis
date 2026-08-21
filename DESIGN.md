# Genesis — design decisions

Genesis is an operate surface: a local-first PWA console for running agent sessions. The visual
system is the **Broomva Design System** (BRO-1583) — Houston's calm monochrome philosophy on an
Arcan-blue OKLCH axis — implemented as tokens in `apps/web/app/globals.css`. This file states the
decisions a review gate (or a future contributor) should read; the stylesheet is the source of truth
for values.

## Stated decisions (what a review gate reads)

- **Typography.** System font stacks, deliberately: `--bv-font-sans` for UI, `--bv-font-heading`
  for headings, `--bv-font-mono` reserved for code blocks only — no mono-terminal chrome. No
  webfont is loaded; a chat console should render instantly and look native.
- **Icons.** Lucide, one system, chosen for the operate surface. Stroke icons only; no emoji as
  UI glyphs.
- **Color.** All colors OKLCH. Every gray sits on the cool blue axis (hue ≈265): ink reads as
  black until you look closely. No pure `#000`; no pure-white text in dark. Semantic tokens
  (`--background` … `--sidebar-ring`) feed shadcn utilities; DS accents are `--bv-blue*`; status
  text grades are `--bv-green-text` / `--bv-amber-text` (darker than the fill grades `--bv-success`
  / `--bv-warning`, for contrast on the light canvas). The only hex literals in TSX are the two
  `themeColor` meta values in `app/layout.tsx` — `<meta>` cannot read CSS custom properties.
- **Radius.** The shadcn ladder derived from a single `--radius` (0.625rem): `sm/md/lg/xl/2xl+`
  by multiplication, so one edit retunes the app. Two signature radii on top: `--bv-radius-composer`
  (28px) and `--bv-radius-bubble` (asymmetric — soft corners with a spoken tail at the sender edge).
  App-level components use ladder steps or the signatures; `calc(var(--radius)-Npx)` forms inside
  `components/ui/` are vendored shadcn idiom and stay as shipped.
- **Elevation.** Named DS shadows only: `--bv-shadow-edge` (hairline), `--bv-shadow-card-hover`,
  `--bv-shadow-composer`, `--bv-shadow-glow`. Tailwind's `shadow-sm/md/lg/xl` appear only inside
  vendored `components/ui/`. `shadow-none` is a deliberate flattening, not drift.
- **Glass.** Backdrop blur is reserved for overlay chrome — dialog scrims, the settings sheet,
  the workspace browser header — using the DS `--glass-*` tokens. Never on content cards.
- **Gradients.** Functional only: the streamdown shimmer (loading signal) and scroll-edge fades in
  the chat view, both built from semantic tokens. No decorative gradients, no purple-to-black.
- **Motion.** Small and purposeful (fade/slide under 250ms); `prefers-reduced-motion` respected
  globally. The thinking indicator is the one persistent animation and it carries state.
- **Voice.** Sentence case. Plain declarative sentences; punctuation does the joining (periods,
  semicolons, colons) — no em dashes in user-facing copy, no emoji, no checkmark bullets, no
  "it's not X, it's Y". Hints say what happens and what to do next, in the product's own words.
- **Legal.** Genesis is a self-hosted operate console behind login; it ships no marketing claims.
  Terms/privacy for the hosted Broomva account live with the account system (broomva.tech), not in
  this app shell. If Genesis is ever offered as a hosted product, `/terms` and `/privacy` routes
  become a launch blocker — tracked, not faked.

## Provenance

Authored during the unslop arc BRO-2196 (2026-08-20), documenting the incumbent system rather than
inventing a new one; drift found by the survey (undeclared status-text tokens, one undeclared
signature radius, off-ladder utilities, em-dash copy) was normalized to the decisions above.
