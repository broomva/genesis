// Read-only CI status for a workspace's repo (BRO-1669, Slice 4a — the Checks tab).
// Shells the GitHub CLI (`gh`) read-only, the same way the git routes shell `git`:
//
//   • FIXED argv — the only non-literal value is the branch, and it's derived
//     server-side (`git branch --show-current`), never client input, so nothing the
//     client sends reaches a gh/git argument.
//   • confined to a true repo ROOT (reuses `isRepoRoot`), so a subdir workspace can't
//     surface the enclosing repo's CI.
//   • bounded (timeout + maxBuffer, SIGKILL-reaped) and DEGRADES gracefully — a repo
//     that isn't on GitHub, an unauthenticated gh, or a repo with no Actions all
//     return `{ available:false, … }` / an empty run list rather than throwing.
//   • only run metadata (names/status/urls) leaves — never the rootPath.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isRepoRoot } from "./workspace-git";

const execFileAsync = promisify(execFile);

const CHECKS_TIMEOUT_MS = 20_000; // gh hits the network
const CHECKS_MAXBUFFER = 4 * 1024 * 1024;
/** Max recent runs surfaced. */
export const MAX_CHECK_RUNS = 20;

export interface CheckRun {
  id: number;
  /** The run's display title (commit / PR title). */
  title: string;
  /** The workflow name. */
  workflow: string;
  /** `queued` | `in_progress` | `completed` | … */
  status: string;
  /** `success` | `failure` | `cancelled` | `skipped` | … ; null while running. */
  conclusion: string | null;
  url: string;
  createdAt: string;
}

export interface ChecksResult {
  /** False when the workspace isn't a GitHub repo / gh isn't authenticated. */
  available: boolean;
  /** `owner/name` when resolvable. */
  repo?: string;
  branch?: string;
  runs: CheckRun[];
  /** A short, SAFE reason when `available` is false or there are no runs. */
  reason?: string;
}

/** Read-only, non-interactive gh/git env; SIGKILL-reaped on timeout. */
function checksOpts(rootPath: string) {
  return {
    cwd: rootPath,
    timeout: CHECKS_TIMEOUT_MS,
    maxBuffer: CHECKS_MAXBUFFER,
    killSignal: "SIGKILL" as const,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_PAGER: "cat",
    },
  };
}

/** Map a gh failure to a SHORT, safe reason (never leaks paths / stderr verbatim). */
export function classifyGhError(e: unknown): string {
  const err = e as { code?: unknown; stderr?: unknown };
  if (typeof err?.code === "string") return "GitHub CLI is not installed on this server";
  const stderr = typeof err?.stderr === "string" ? err.stderr : "";
  if (/auth|logged in|GH_TOKEN|gh auth login/i.test(stderr))
    return "GitHub CLI is not authenticated on this server";
  if (
    /not a git repository|no git remotes|none of the git remotes|could not determine/i.test(stderr)
  )
    return "this workspace isn't a GitHub repository";
  return "couldn't reach GitHub";
}

/** Parse `gh run list --json …` stdout into a clean, defensive {@link CheckRun}[]. */
export function parseRunsJson(stdout: string): CheckRun[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((r) => ({
      id: typeof r.databaseId === "number" ? r.databaseId : 0,
      title: typeof r.displayTitle === "string" ? r.displayTitle : "",
      workflow: typeof r.workflowName === "string" ? r.workflowName : "",
      status: typeof r.status === "string" ? r.status : "",
      conclusion: typeof r.conclusion === "string" && r.conclusion.length > 0 ? r.conclusion : null,
      url: typeof r.url === "string" ? r.url : "",
      createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    }));
}

const RUN_FIELDS = "databaseId,displayTitle,status,conclusion,workflowName,createdAt,url";

/** The recent CI runs for a workspace repo's current branch. Read-only; never throws
 *  on a non-GitHub / unauthenticated / no-Actions workspace — returns a graceful
 *  `{ available:false, … }` or an empty run list with a reason. */
export async function workspaceChecks(rootPath: string): Promise<ChecksResult> {
  if (!(await isRepoRoot(rootPath)))
    return { available: false, runs: [], reason: "this workspace isn't a git repository" };

  const branch = await execFileAsync("git", ["branch", "--show-current"], checksOpts(rootPath))
    .then((r) => r.stdout.trim() || undefined)
    .catch(() => undefined);

  // `gh repo view` validates BOTH that it's a GitHub repo AND that gh is authenticated.
  let repo: string | undefined;
  try {
    const r = await execFileAsync(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      checksOpts(rootPath),
    );
    repo = r.stdout.trim() || undefined;
  } catch (e) {
    return { available: false, runs: [], branch, reason: classifyGhError(e) };
  }

  const args = ["run", "list", "--limit", String(MAX_CHECK_RUNS), "--json", RUN_FIELDS];
  if (branch) args.push("--branch", branch);
  try {
    const r = await execFileAsync("gh", args, checksOpts(rootPath));
    const runs = parseRunsJson(r.stdout);
    return {
      available: true,
      repo,
      branch,
      runs,
      ...(runs.length === 0 ? { reason: "no recent workflow runs for this branch" } : {}),
    };
  } catch {
    // Actions disabled / no runs → a valid repo with nothing to show.
    return { available: true, repo, branch, runs: [], reason: "no workflow runs" };
  }
}
