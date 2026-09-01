// Serving the walkie PWA from Genesis itself (BRO-2416).
//
// WHY GENESIS SERVES IT RATHER THAN A SECOND HOST. Genesis sends no CORS headers
// on /walkie/* and has no OPTIONS handler — measured: a cross-origin preflight
// for POST /walkie/answer returns 404, and GET /walkie/asks with an Origin
// returns 200 with no Access-Control-* at all. So a client hosted anywhere else
// has its reads withheld from JS by the browser and its writes never sent.
//
// The two ways out were: serve the client here (one origin, no CORS surface, the
// secret never crosses an origin boundary) or grow an origin allowlist on
// credentialed routes. The first wins on evidence rather than taste — there is no
// third-party client to serve, the routes are already gated by one shared bearer
// secret, and an allowlist would add a trust boundary to protect a client we also
// control.
//
// AND IT NEEDS NO PUBLIC EXPOSURE. The operator's phone is on the tailnet, and
// `tailscale serve` publishes only the /voice prefix to the internet. So the
// client is reachable from the phone and from nowhere else, which is a better
// posture than any CORS configuration could have produced.
//
// THE SHELL IS NOT SECRET. index.html, app.js and app.css contain no credential —
// the client reads its secret from localStorage, deliberately, so the bundle can
// be served without one. Gating the shell behind the walkie secret would mean
// putting that secret in a URL to fetch the page that asks for it.

import { realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** Extension → content type. An allowlist, not a lookup with a permissive
 *  default: an unknown extension is a file this route was not meant to serve, and
 *  guessing a type for it is how a directory of build output becomes a directory
 *  of arbitrary downloads. */
const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface ResolvedAsset {
  readonly path: string;
  readonly type: string;
}

/** Resolve a request path to a file inside `root`, or undefined.
 *
 *  THE ONLY INTERESTING PART IS WHAT IT REFUSES. This maps attacker-controlled
 *  path text onto a filesystem, which is the classic traversal surface, so the
 *  check is not "does the string contain .." — that misses `%2e%2e` (the router
 *  decodes before this sees it), absolute paths, backslashes on some platforms,
 *  and symlinks pointing out of the tree. It RESOLVES the candidate and requires
 *  the result to be inside the resolved root, which is a property of the answer
 *  rather than of the input.
 *
 *  A directory is not an asset: without that check, requesting a directory path
 *  reaches `Bun.file` on a directory and the failure mode is platform-dependent.
 */
export function resolveAsset(root: string, requestPath: string): ResolvedAsset | undefined {
  // REALPATH BOTH SIDES. `resolve` is pure path arithmetic and does not follow
  // symlinks, so a link INSIDE the root resolves to a path inside the root and
  // passes containment — while the read follows it anywhere the process can
  // reach. A test written for that hypothetical found it was real.
  //
  // The root is realpath'd too, and not only for symmetry: on macOS /tmp is
  // itself a symlink to /private/tmp, so comparing a realpath'd candidate
  // against a merely resolved root would refuse every legitimate file under a
  // temp root — a fail-closed bug that looks like a security win in tests.
  let base: string;
  try {
    base = realpathSync(resolve(root));
  } catch {
    return undefined; // the configured directory does not exist
  }
  // Trailing "/" or an empty path is the document.
  const rel =
    requestPath === "" || requestPath.endsWith("/") ? `${requestPath}index.html` : requestPath;
  let candidate: string;
  try {
    candidate = realpathSync(resolve(join(base, rel)));
  } catch {
    return undefined; // missing, or a broken link
  }
  // `${base}${sep}` and not just `base`: a sibling directory whose name merely
  // STARTS with the root's name (…/dist-evil beside …/dist) passes a bare
  // startsWith and is outside the tree.
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) return undefined;
  if (statSync(candidate).isDirectory()) return undefined;
  const dot = candidate.lastIndexOf(".");
  const ext = dot === -1 ? "" : candidate.slice(dot).toLowerCase();
  const type = TYPES[ext];
  if (!type) return undefined;
  return { path: candidate, type };
}
