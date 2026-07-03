// Client helpers for the read-only Checks tab (BRO-1669). Talks to the BFF proxy
// (/api/workspaces/:id/checks) — never the engine. Normalizers are pure (testable
// without a fetch) + defensive.

export interface CheckRunData {
  id: number;
  title: string;
  workflow: string;
  status: string;
  conclusion: string | null;
  url: string;
  createdAt: string;
}

export interface ChecksData {
  available: boolean;
  repo?: string;
  branch?: string;
  runs: CheckRunData[];
  reason?: string;
}

/** A coarse run state for badge rendering. */
export type RunState = "success" | "failure" | "running" | "pending" | "neutral";

/** Fold a run's status + conclusion into one badge state. */
export function runState(run: CheckRunData): RunState {
  if (run.status !== "completed") return run.status === "in_progress" ? "running" : "pending";
  switch (run.conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "failure";
    default:
      return "neutral"; // cancelled / skipped / neutral / action_required / stale / …
  }
}

/** Coerce an untrusted `/checks` body into a clean {@link ChecksData}. */
export function normalizeChecks(data: unknown): ChecksData {
  const d = (data ?? {}) as Record<string, unknown>;
  const runs: CheckRunData[] = Array.isArray(d.runs)
    ? d.runs
        .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
        .map((r) => ({
          id: typeof r.id === "number" ? r.id : 0,
          title: typeof r.title === "string" ? r.title : "",
          workflow: typeof r.workflow === "string" ? r.workflow : "",
          status: typeof r.status === "string" ? r.status : "",
          conclusion:
            typeof r.conclusion === "string" && r.conclusion.length > 0 ? r.conclusion : null,
          url: typeof r.url === "string" ? r.url : "",
          createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
        }))
    : [];
  return {
    available: d.available === true,
    repo: typeof d.repo === "string" ? d.repo : undefined,
    branch: typeof d.branch === "string" ? d.branch : undefined,
    runs,
    reason: typeof d.reason === "string" ? d.reason : undefined,
  };
}

/** Fetch the recent CI runs for a workspace. Rejects with the engine's SAFE message. */
export async function fetchChecks(workspaceId: string, signal?: AbortSignal): Promise<ChecksData> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/checks`, { signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof (data as { error?: unknown })?.error === "string"
        ? (data as { error: string }).error
        : "could not read checks",
    );
  }
  return normalizeChecks(data);
}
