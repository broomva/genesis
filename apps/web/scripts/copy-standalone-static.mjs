// Make the Next standalone bundle self-contained (BRO-1659).
//
// `output: "standalone"` (next.config.ts) emits a minimal `server.js` under
// `.next/standalone/…` but DELIBERATELY does not bundle `.next/static` or
// `public` — Next leaves that copy to the deployer so those assets can optionally
// be served from a CDN. Genesis serves them from the same box, so the copy is
// required on EVERY build. Skipping it is a silent-blank-page footgun: the server
// still boots and returns HTTP 200 for HTML, but every `/_next/static/*` request
// 404s → no CSS, no client JS, no hydration (unstyled page stuck on "Loading…").
// That exact incident happened deploying BRO-1657; this runs as part of `build`
// so the manual step can never be skipped again. See apps/web/README.md.
//
// Idempotent + cross-platform (fs.cpSync, no shell `cp`). No-ops when there's no
// standalone dir (e.g. a non-standalone/aborted build) so it never fails a build.

import { cpSync, existsSync } from "node:fs";

// Monorepo-aware standalone root (outputFileTracingRoot = workspaceRoot in
// next.config.ts nests the app under apps/web inside standalone). CWD is apps/web.
const STANDALONE = ".next/standalone/apps/web";

if (!existsSync(`${STANDALONE}/.next`)) {
  console.log(`[copy-standalone-static] no standalone build at ${STANDALONE} — skipping`);
  process.exit(0);
}

// `.next/static` → served at `/_next/static/*`. Required for CSS + client chunks.
cpSync(".next/static", `${STANDALONE}/.next/static`, { recursive: true });

// `public/*` → served at the site root (manifest icons, etc.). Optional.
const hasPublic = existsSync("public");
if (hasPublic) {
  cpSync("public", `${STANDALONE}/public`, { recursive: true });
}

console.log(
  `[copy-standalone-static] copied .next/static${hasPublic ? " + public" : ""} into ${STANDALONE}`,
);
