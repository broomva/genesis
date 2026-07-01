import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Workspace } from "@genesis/core";
import { scanGitRepos, slugifyWorkspace } from "./workspaces";

const execFileAsync = promisify(execFile);

/** A rejected client PICK (bad name / traversal / non-git / escape). Its message is
 *  SAFE to echo to the client (400); any OTHER error from registration is internal
 *  (FS EACCES/ENOSPC with an absolute path) and must NOT be echoed (P20 Forge SF2). */
export class WorkspaceValidationError extends Error {}

// Discover→pick provisioning (BRO-1629, Phase 2.5 · slice 2). The security spine:
// the CLIENT NEVER NAMES A FILESYSTEM PATH. It picks a directory NAME surfaced by
// GET /workspaces/available (repos under the admin allow-root); the server derives
// + validates the rootPath inside the allow-root. A rootPath is arbitrary-location
// code execution + `../` traversal — filesystem authority never leaves the server.

export interface AvailableRepo {
  /** The directory name (what the client picks). */
  name: string;
  /** The workspace id it would register as. */
  id: string;
}

/** Deterministic short hash (djb2) → 6 hex, to disambiguate slug collisions. */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

/** Git repos under the allow-root that aren't already registered (by derived id). */
export function availableWorkspaces(
  allowRoot: string | undefined,
  registeredIds: ReadonlySet<string>,
): AvailableRepo[] {
  if (!allowRoot) return [];
  return scanGitRepos(allowRoot)
    .map((r) => ({ name: r.name, id: `ws-${slugifyWorkspace(r.name)}` }))
    .filter((r) => !registeredIds.has(r.id));
}

/** Resolve a client PICK (a directory name under the allow-root) into a full
 *  Workspace — the server derives + validates the rootPath. Throws on an invalid
 *  pick (missing allow-root, unsafe name, escapes the root, not a dir, not a git
 *  repo). `takenIds` disambiguates a slug collision deterministically (never
 *  overwrites an existing workspace with a different path). */
export function resolvePick(
  allowRoot: string | undefined,
  pick: unknown,
  takenIds: ReadonlySet<string>,
): Workspace {
  if (!allowRoot) throw new WorkspaceValidationError("no projects root configured");
  if (
    typeof pick !== "string" ||
    pick.length === 0 ||
    pick.includes("/") ||
    pick.includes("\\") ||
    pick.includes("..") ||
    pick.startsWith(".")
  ) {
    throw new WorkspaceValidationError(
      "invalid pick (must be a plain directory name under the projects root)",
    );
  }
  const base = resolve(allowRoot);
  const rootPath = resolve(allowRoot, pick);
  if (rootPath !== base && !rootPath.startsWith(base + sep)) {
    throw new WorkspaceValidationError("pick escapes the projects root");
  }
  if (!existsSync(rootPath))
    throw new WorkspaceValidationError(`pick "${pick}" not found under the projects root`);
  if (!existsSync(resolve(rootPath, ".git")))
    throw new WorkspaceValidationError(`"${pick}" is not a git repository`);
  // HARD boundary (P20 Forge SF1): the lexical startsWith is symlink-blind, and the
  // scan deliberately follows symlink-to-dir — so a symlink inside the allow-root
  // pointing OUTSIDE would store a path lexically-inside but real-outside, letting
  // the agent cwd off-boundary. Re-check the REAL paths so the allow-root is a hard
  // sandbox, not a lexical one.
  const realRoot = realpathSync(base);
  const realPath = realpathSync(rootPath);
  if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) {
    throw new WorkspaceValidationError("pick resolves outside the projects root (symlink)");
  }
  let id = `ws-${slugifyWorkspace(pick)}`;
  if (takenIds.has(id)) id = `${id}-${shortHash(rootPath)}`;
  return { id, name: pick, rootPath, isGitRepo: true };
}

// ─── Add-by-git-URL provisioning (BRO-1629, Phase 2.5b · slice 5) ──────────────
// The second safe add shape (alongside discover→pick): the client posts a git URL,
// the server clones it INTO the allow-root and registers it. Same security spine as
// resolvePick — the client still never names a filesystem PATH; here it names a
// remote URL, and the server derives the target dir name (from the repo slug) inside
// the allow-root. The load-bearing controls are: (1) an https-only + host-ALLOWLIST
// gate (the SSRF firewall — no IP literals, no localhost/RFC-1918/link-local/metadata
// hosts, no file://ssh://git://), (2) no embedded credentials, (3) a server-derived
// target that provably stays inside the allow-root, (4) a bounded, non-interactive,
// depth-1 clone that can't hang on an auth prompt.

/** Where cloned repos are quarantined mid-fetch, then atomically renamed into the
 *  allow-root. A hidden, non-git dir → scanGitRepos/availableWorkspaces skip it, so
 *  a half-cloned repo is never surfaced as a pickable workspace. */
const CLONE_TMP_DIR = ".genesis-clone-tmp";

/** Default git hosts we'll clone from. An allowlist (not an IP denylist) is the
 *  simplest airtight SSRF defense: only known public git hosts are reachable, so a
 *  metadata-IP / localhost / RFC-1918 URL is rejected for free (it's not listed).
 *  GENESIS_GIT_URL_HOSTS (comma-separated) UNIONS in self-hosted hosts. */
const DEFAULT_GIT_HOSTS = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"] as const;

export interface GitUrlPolicy {
  /** Lower-cased hostnames a clone URL may target. */
  allowedHosts: ReadonlySet<string>;
  /** Hard ceiling on a single clone (ms) — a non-interactive clone that stalls
   *  (huge repo, slow host) is killed rather than pinning a request forever. */
  cloneTimeoutMs: number;
}

/** Build the clone policy from env (defaults + GENESIS_GIT_URL_HOSTS union). */
export function defaultGitUrlPolicy(
  env: Record<string, string | undefined> = process.env,
): GitUrlPolicy {
  const extra = (env.GENESIS_GIT_URL_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const timeout = Number(env.GENESIS_GIT_CLONE_TIMEOUT_MS);
  return {
    allowedHosts: new Set<string>([...DEFAULT_GIT_HOSTS, ...extra]),
    cloneTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 120_000,
  };
}

/** A client git URL, validated + resolved into a server-side target. */
export interface ResolvedGitUrl {
  /** The normalized URL to clone (href from the parser — canonical form). */
  url: string;
  /** The derived workspace/dir name (repo slug, matching `git clone`'s own leaf). */
  name: string;
  /** The absolute clone destination, provably inside the allow-root. */
  targetPath: string;
  /** The workspace id it will register as (disambiguated on a slug collision). */
  id: string;
}

/** Validate a client-supplied git URL against the SSRF/scheme/credential policy and
 *  derive the server-side target (dir name + path inside the allow-root). Pure — no
 *  filesystem writes, no network — so the rejection matrix is unit-testable in
 *  isolation. Throws {@link WorkspaceValidationError} (safe to echo as a 400) on any
 *  rejection; the message never contains an absolute server path. */
export function resolveGitUrl(
  allowRoot: string | undefined,
  gitUrl: unknown,
  takenIds: ReadonlySet<string>,
  policy: GitUrlPolicy,
): ResolvedGitUrl {
  if (!allowRoot) throw new WorkspaceValidationError("no projects root configured");
  if (typeof gitUrl !== "string" || gitUrl.length === 0 || gitUrl.length > 2048) {
    throw new WorkspaceValidationError("invalid git URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(gitUrl);
  } catch {
    throw new WorkspaceValidationError("invalid git URL");
  }
  // https ONLY — blocks file:// (local disclosure), ssh:// + scp-style (creds /
  // key auth), git:// (cleartext), http:// (downgrade), data:/blob: etc.
  if (parsed.protocol !== "https:") {
    throw new WorkspaceValidationError("git URL must use https://");
  }
  // No `user:pass@host` — an embedded credential would be cloned + logged; force
  // unauthenticated public clones (private repos come later via a token seam).
  if (parsed.username || parsed.password) {
    throw new WorkspaceValidationError("git URL must not embed credentials");
  }
  // Only the default https port. Allowlisted hosts all serve on 443; a custom port
  // is an SSRF-pivot smell (host:port to an internal service behind a lookalike).
  if (parsed.port && parsed.port !== "443") {
    throw new WorkspaceValidationError("git URL must use the default https port");
  }
  // The SSRF firewall: host must be allowlisted. This one check subsumes the whole
  // metadata-IP / localhost / RFC-1918 / link-local denylist — none are listed.
  const host = parsed.hostname.toLowerCase();
  if (!policy.allowedHosts.has(host)) {
    const allowed = [...policy.allowedHosts].sort().join(", ");
    throw new WorkspaceValidationError(`git host "${host}" is not allowed (allowed: ${allowed})`);
  }
  // Derive the dir name from the LAST path segment minus a .git suffix — exactly
  // what `git clone <url>` names the checkout, so the mental model is least-surprise.
  const segments = parsed.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  const name = slugifyWorkspace(last.replace(/\.git$/i, ""));
  // slugifyWorkspace falls back to "ws" for an all-punctuation segment → an opaque,
  // meaningless target; reject rather than clone into it.
  if (!name || name === "ws") {
    throw new WorkspaceValidationError("could not derive a project name from the git URL");
  }
  // Same spatial boundary as resolvePick: the derived target must stay inside the
  // allow-root. `name` is already a slug (no separators), but re-assert the invariant
  // rather than trust the derivation (defense-in-depth).
  const base = resolve(allowRoot);
  const targetPath = resolve(allowRoot, name);
  if (targetPath !== base && !targetPath.startsWith(base + sep)) {
    throw new WorkspaceValidationError("derived path escapes the projects root");
  }
  let id = `ws-${name}`;
  if (takenIds.has(id)) id = `${id}-${shortHash(targetPath)}`;
  return { url: parsed.href, name, targetPath, id };
}

/** rm a path, swallowing errors (best-effort cleanup of a temp/partial clone). */
function rmSafe(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // best-effort — a leftover under .genesis-clone-tmp is inert (never surfaced).
  }
}

/** The real clone: non-interactive, credential-less, shallow, single-branch, bounded.
 *  GIT_TERMINAL_PROMPT=0 + an empty credential.helper guarantee it can never block
 *  waiting for auth (a private/typo'd URL fails fast instead of hanging the request).
 *  Async (execFile, not execFileSync) so a slow clone never pins the event loop. */
async function gitClone(url: string, target: string, timeoutMs: number): Promise<void> {
  await execFileAsync(
    "git",
    [
      "-c",
      "credential.helper=", // ignore any ambient stored credentials
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      "--",
      url,
      target,
    ],
    {
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
    },
  );
}

/** Clone a validated git URL into the allow-root and return the Workspace to register
 *  (the caller does `supervisor.registerWorkspace` — idempotent-by-rootPath). Clones
 *  into a hidden temp dir then ATOMICALLY renames into place, so (a) a half-cloned
 *  repo is never visible + (b) a concurrent same-URL double-submit can't clobber a
 *  sibling's good checkout (the loser's rename fails ENOTEMPTY → 400, not a partial
 *  overwrite). `clone` is injectable so the happy path is testable without network.
 *  Throws {@link WorkspaceValidationError} (safe 400) on any rejection. */
export async function provisionFromGitUrl(
  allowRoot: string | undefined,
  gitUrl: unknown,
  takenIds: ReadonlySet<string>,
  opts: {
    policy?: GitUrlPolicy;
    clone?: (url: string, target: string, timeoutMs: number) => Promise<void>;
  } = {},
): Promise<Workspace> {
  const policy = opts.policy ?? defaultGitUrlPolicy();
  const clone = opts.clone ?? gitClone;
  const { url, name, targetPath, id } = resolveGitUrl(allowRoot, gitUrl, takenIds, policy);

  // Fail fast before spending a clone if the destination is already occupied.
  if (existsSync(targetPath)) {
    throw new WorkspaceValidationError(
      `a directory named "${name}" already exists under the projects root`,
    );
  }

  // biome-ignore lint/style/noNonNullAssertion: allowRoot is validated non-undefined by resolveGitUrl above.
  const tmpRoot = resolve(allowRoot!, CLONE_TMP_DIR);
  mkdirSync(tmpRoot, { recursive: true });
  const tmp = resolve(tmpRoot, `${process.pid}.${randomUUID().slice(0, 8)}`);

  try {
    await clone(url, tmp, policy.cloneTimeoutMs);
  } catch {
    rmSafe(tmp);
    // Generic — never echo git's stderr (may carry the absolute target path).
    throw new WorkspaceValidationError(
      "git clone failed (check the URL points to a public repository)",
    );
  }
  if (!existsSync(resolve(tmp, ".git"))) {
    rmSafe(tmp);
    throw new WorkspaceValidationError("clone did not produce a git repository");
  }
  // Atomic publish. If the destination appeared during the clone (a racing add or a
  // manual mkdir), refuse to clobber it and drop the temp.
  if (existsSync(targetPath)) {
    rmSafe(tmp);
    throw new WorkspaceValidationError(
      `a directory named "${name}" already exists under the projects root`,
    );
  }
  try {
    renameSync(tmp, targetPath);
  } catch {
    rmSafe(tmp);
    throw new WorkspaceValidationError(
      `a directory named "${name}" already exists under the projects root`,
    );
  }
  return { id, name, rootPath: targetPath, isGitRepo: true };
}
