// Single-runner lock for the confinement eval (BRO-2245).
//
// WHY THIS EXISTS. On 2026-08-23 two confinement evals were started concurrently
// on srv1692698 alongside live probe traffic. Each eval spawns a series of real
// `claude` sessions against the deployed box; the host went to load ~15 and then
// stopped scheduling userspace entirely — sshd completed key exchange but never
// returned a shell, genesis-api went 200@20s -> 200@25s -> nothing, and the
// WhatsApp channel stopped answering for two real tenants. Recovery needed a
// console reboot because every remote lever was already unreachable.
//
// The precise resource that ran out was never captured (no shell to capture it
// with), so this guard is deliberately conservative rather than tuned: it does
// not model load, it just refuses to let a second eval start. That is the one
// invariant the incident supports without further evidence.
//
// EXIT SEMANTICS. Refusing to start exits 2, matching the file this guards:
// confinement-eval.ts already uses 2 for INVALID, on the rule that a run which
// could not measure is not a run that passed. A concurrent run cannot produce a
// trustworthy verdict either — it perturbs the very box it is measuring — so it
// belongs in the same bucket, NOT in the exit-1 "boundary failed" bucket.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/** Recorded holder of the lock. `startedAt` is an ISO string so a stale file is
 *  readable by a human deciding whether to clear it by hand. */
export interface LockRecord {
  readonly pid: number;
  readonly startedAt: string;
  readonly tenantDir: string;
}

export type LockOutcome =
  | { readonly ok: true; readonly tookOverStaleFrom?: number }
  | { readonly ok: false; readonly heldBy: LockRecord };

/** True when a process with this pid exists and we may signal it.
 *
 *  `process.kill(pid, 0)` sends no signal and only performs the existence and
 *  permission check. EPERM means the process EXISTS but belongs to another user
 *  — that must count as alive, because treating it as dead is exactly how a
 *  guard hands out a lock that is still held. Only ESRCH means "no such
 *  process". */
export function isProcessAlive(pid: number, kill: (p: number, s: number) => void): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Decide what to do about an existing lock file's contents.
 *
 *  Split out from the filesystem so the decision is testable without spawning
 *  processes: every branch here is reachable from a plain object. */
export function decideFromRecord(raw: string | null, alive: (pid: number) => boolean): LockOutcome {
  if (raw === null) return { ok: true };

  let record: LockRecord;
  try {
    record = JSON.parse(raw) as LockRecord;
  } catch {
    // An unparseable lock is not a held lock. It is a crashed writer or a
    // truncated write; refusing forever on corrupt bytes would be a worse
    // failure than taking over, and the takeover is recorded in the result.
    return { ok: true, tookOverStaleFrom: 0 };
  }

  // `?? 0` would NOT do here: a lock whose pid is a non-null non-number (say the
  // string "x" from a hand-edited file) is not nullish, so it would flow through
  // and be reported as `tookOverStaleFrom: "x"` — a string in a field typed
  // number, which TypeScript cannot catch because it arrives from JSON.parse as
  // `any`. Coerce on the type, not on nullishness.
  if (typeof record?.pid !== "number" || !alive(record.pid)) {
    return { ok: true, tookOverStaleFrom: typeof record?.pid === "number" ? record.pid : 0 };
  }
  return { ok: false, heldBy: record };
}

/** Acquire the lock, or report who holds it. Callers that get `ok: false` must
 *  NOT proceed — see the exit semantics note at the top of this file. */
export function acquireEvalLock(
  lockPath: string,
  tenantDir: string,
  deps: {
    readFile?: (p: string) => string | null;
    writeFile?: (p: string, body: string) => void;
    kill?: (p: number, s: number) => void;
    pid?: number;
    now?: () => string;
  } = {},
): LockOutcome {
  const readFile =
    deps.readFile ?? ((p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null));
  const writeFile = deps.writeFile ?? ((p: string, body: string) => writeFileSync(p, body));
  const kill = deps.kill ?? ((p: number, s: number) => process.kill(p, s));
  const pid = deps.pid ?? process.pid;
  const now = deps.now ?? (() => new Date().toISOString());

  const outcome = decideFromRecord(readFile(lockPath), (p) => isProcessAlive(p, kill));
  if (!outcome.ok) return outcome;

  const record: LockRecord = { pid, startedAt: now(), tenantDir };
  writeFile(lockPath, `${JSON.stringify(record, null, 2)}\n`);
  return outcome;
}

/** Best-effort release. Never throws: a failure to unlink must not turn a
 *  completed eval into a failed one, and a leftover file is handled by the
 *  stale-takeover path on the next run. */
export function releaseEvalLock(lockPath: string): void {
  try {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch {
    // Intentionally swallowed — see above.
  }
}

/** Operator-facing refusal text. Kept here so the message and the exit code
 *  that carries it stay in one place. */
export function refusalMessage(held: LockRecord, lockPath: string): string {
  return [
    `confinement eval REFUSED: another run is already in progress (pid ${held.pid}, started ${held.startedAt}).`,
    `  tenant: ${held.tenantDir}`,
    `  lock:   ${lockPath}`,
    "",
    "Two concurrent evals took this host down on 2026-08-23 and it needed a console reboot.",
    "Wait for the running eval, or if you are certain it is dead, remove the lock file.",
  ].join("\n");
}
