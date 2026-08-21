# unslop plan — genesis apps/web (BRO-2196)

Direction: incumbent Broomva DS (BRO-1583) is committed and good → DOCUMENT it (DESIGN.md at repo
root), then normalize drift to it. No new world drawn.

| kind | current | root file | the single edit | blast |
|---|---|---|---|---|
| color | `var(--bv-green-text,#2e7d32)` / `var(--bv-amber-text,#b8860b)` fallbacks ×8 — tokens never declared | app/globals.css | declare both tokens (light text-grade + dark), drop every inline fallback | workspace-browser.tsx |
| radius | `rounded-[1.5rem_1.5rem_0.375rem_1.5rem]` undeclared signature; bare `rounded` ×3 off-ladder | app/globals.css | `--bv-radius-bubble` token; bare `rounded` → `rounded-sm` | chat-view.tsx, workspace-browser.tsx |
| shadow | DS-named + vendored ladder | — | stated in DESIGN.md (no drift to fix) | — |
| gradient/glass | functional only (shimmer, scroll fades, overlay chrome) | — | stated in DESIGN.md | — |
| icons | lucide ×25 | — | stated decision | — |
| copy voice | 14 em-dash UI strings | (per string) | rewrite: periods/semicolons/colons, product's own words | 8 files |
| survey FP | 7/21 em-dash "sites" were block-comment continuations | unslop itself | fixed upstream: skills#177 (0.2.1) | — |

Class D: legal MISSING is a stated decision for a self-hosted operate console (DESIGN.md §Legal) —
waived with that reason, revisit on hosted launch. Async surfaces 2/2 loading+error. No placeholders,
no testimonials, no pricing scaffold. Product evidence: operate console behind auth.
