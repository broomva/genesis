// Single-runner lock for the confinement eval (BRO-2245).
//
// WHY THIS EXISTS. On 2026-08-23 two confinement evals were started concurrently
// on srv1692698 alongside live probe traffic. Each eval spawns a series of real
// `claude` sessions against the deployed box; the host went to load ~15 and then
// stopped scheduling userspace — sshd completed key exchange but never returned
// a shell, genesis-api went 200@20s -> 200@25s -> nothing, and the WhatsApp
// channel stopped answering for two real tenants. Recovery needed a console
// reboot because every remote lever was already unreachable.
//
// WHAT IT DOES AND DOES NOT CLAIM. It bounds concurrent EVALS to one. It does
// NOT control tenant traffic or operator probes, which were also present during
// the incident, and the resource that actually ran out was never captured (there
// was no shell to capture it with). So this removes one contributor to a
// multi-source overload; it is not a proof against recurrence.
//
// EXIT SEMANTICS. Refusing exits 2, matching the file this guards:
// confinement-eval.ts already uses 2 for INVALID, on the rule that a run which
// could not measure is not a run that passed. A concurrent run cannot produce a
// trustworthy verdict either — it perturbs the very box it is measuring — so it
// belongs in the same bucket, NOT in the exit-1 "boundary failed" bucket.
//
// MUTUAL EXCLUSION IS THE `wx` CREATE, NOT THE READ.
// The first version of this file read the path and then wrote it, which is a
// read-then-write TOCTOU: two runners both observe "no lock", both write, both
// proceed — failing at exactly the job it was added to do. Cross-model review
// and CodeRabbit independently flagged it.
//
// The only ordering point now is `writeFileSync(path, body, { flag: "wx" })`,
// which Bun maps to O_CREAT|O_EXCL: exactly one racer creates the file and every
// other gets EEXIST from the kernel. Reads exist only to REPORT who holds it and
// to judge staleness; no read decides whether we may proceed.
//
// The steal path is race-safe for the same reason. Two runners may both judge a
// lock stale and both unlink it, but they must then both re-enter the `wx`
// create, where exactly one still wins. Unlink is best-effort on purpose.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/** Recorded holder of the lock.
 *
 *  `nonce` is what makes release ownership-checked. pid alone cannot do it: a
 *  runner that stole a stale lock and a runner that later exits could both be
 *  "pid N" across a reuse, and the earlier version's unconditional unlink let
 *  ANY runner delete a lock a DIFFERENT runner was holding — reopening the gate
 *  while that runner was still going. */
export interface LockRecord {
  readonly pid: number;
  readonly startedAt: string;
  readonly tenantDir: string;
  readonly nonce: string;
}

export type LockOutcome =
  | { readonly ok: true; readonly record: LockRecord; readonly tookOverStaleFrom?: number }
  | { readonly ok: false; readonly heldBy: LockRecord | null };

/** A lock older than this is treated as abandoned even if its pid answers.
 *
 *  This is the PID-REUSE mitigation, and it is a heuristic, not a proof: a pid
 *  can be recycled by an unrelated long-lived process, which would otherwise
 *  block every future eval forever with no way to tell from the outside. A
 *  confinement eval is minutes of work, so hours is far outside its envelope. */
export const DEFAULT_MAX_AGE_MS = 3 * 60 * 60 * 1000;

/** True when a process with this pid exists and we may signal it.
 *
 *  `process.kill(pid, 0)` sends no signal and performs only the existence and
 *  permission check. EPERM means the process EXISTS but belongs to another user
 *  — that must count as alive, because treating it as dead is how a guard hands
 *  out a lock that is still held. Only ESRCH means "no such process". */
export function isProcessAlive(pid: number, kill: (p: number, s: number) => void): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function parseRecord(raw: string | null): LockRecord | null {
  if (raw === null) return null;
  try {
    const r = JSON.parse(raw) as LockRecord;
    return typeof r?.pid === "number" ? r : null;
  } catch {
    // Unparseable: a crashed writer, or a partial read of a file another runner
    // is mid-write on. Either way it names no holder we can honour.
    return null;
  }
}

/** Should an EXISTING lock stop us? Reporting only — it never grants the lock.
 *
 *  A record we cannot parse returns `false` (do not honour). That is safe here
 *  ONLY because the caller must still win the `wx` create afterwards; under the
 *  old read-then-write design the same answer would have been a way in. */
export function shouldYieldTo(
  record: LockRecord | null,
  alive: (pid: number) => boolean,
  nowMs: number,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): boolean {
  if (record === null) return false;
  if (!alive(record.pid)) return false;
  const started = Date.parse(record.startedAt);
  // An unparseable timestamp must not silently expire a LIVE holder.
  if (Number.isNaN(started)) return true;
  return nowMs - started < maxAgeMs;
}

export interface LockDeps {
  readFile?: (p: string) => string | null;
  /** MUST create exclusively and throw EEXIST if the path exists. */
  createExclusive?: (p: string, body: string) => void;
  remove?: (p: string) => void;
  kill?: (p: number, s: number) => void;
  pid?: number;
  now?: () => Date;
  nonce?: () => string;
  maxAgeMs?: number;
}

/** Acquire the lock, or report who holds it.
 *
 *  Callers that get `ok: false` must NOT proceed. Callers that get `ok: true`
 *  must pass the returned record to `releaseEvalLock`. */
export function acquireEvalLock(
  lockPath: string,
  tenantDir: string,
  deps: LockDeps = {},
): LockOutcome {
  const readFile =
    deps.readFile ?? ((p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null));
  const createExclusive =
    deps.createExclusive ??
    ((p: string, body: string) => writeFileSync(p, body, { flag: "wx", mode: 0o644 }));
  const remove =
    deps.remove ??
    ((p: string) => {
      try {
        unlinkSync(p);
      } catch {
        // Another racer removed it first; the wx create below still decides.
      }
    });
  const kill = deps.kill ?? ((p: number, s: number) => process.kill(p, s));
  const pid = deps.pid ?? process.pid;
  const now = deps.now ?? (() => new Date());
  const nonce = deps.nonce ?? (() => crypto.randomUUID());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  let tookOverStaleFrom: number | undefined;

  // Bounded: each attempt either wins the create, yields, or removes one stale
  // file. Without a bound, two runners repeatedly stealing from each other could
  // spin. Three is enough for the real cases (free / stale / stale-then-taken).
  for (let attempt = 0; attempt < 3; attempt++) {
    const record: LockRecord = {
      pid,
      startedAt: now().toISOString(),
      tenantDir,
      nonce: nonce(),
    };
    try {
      createExclusive(lockPath, `${JSON.stringify(record, null, 2)}\n`);
      return tookOverStaleFrom === undefined
        ? { ok: true, record }
        : { ok: true, record, tookOverStaleFrom };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }

    const held = parseRecord(readFile(lockPath));
    if (shouldYieldTo(held, (p) => isProcessAlive(p, kill), now().getTime(), maxAgeMs)) {
      return { ok: false, heldBy: held };
    }
    tookOverStaleFrom = held?.pid ?? 0;
    remove(lockPath);
  }

  // Lost every race to a live competitor: correct outcome, not an error.
  return { ok: false, heldBy: parseRecord(readFile(lockPath)) };
}

/** Release ONLY if the lock still names us.
 *
 *  Unconditional unlink was a real defect in the first version: a runner that
 *  had taken over a stale lock could later have its own lock deleted by the
 *  earlier runner's exit handler, reopening the gate mid-run. Returns whether a
 *  file was actually removed, so a caller can log a surprising answer. */
export function releaseEvalLock(
  lockPath: string,
  record: LockRecord | null,
  deps: Pick<LockDeps, "readFile" | "remove"> = {},
): boolean {
  if (!record) return false;
  const readFile =
    deps.readFile ?? ((p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null));
  const remove =
    deps.remove ??
    ((p: string) => {
      try {
        unlinkSync(p);
      } catch {
        // Best effort: a failed unlink must not turn a completed eval into a
        // failed one. A leftover file is handled by the stale path next run.
      }
    });

  const held = parseRecord(readFile(lockPath));
  if (held?.nonce !== record.nonce) return false;
  remove(lockPath);
  return true;
}

/** Operator-facing refusal text. Kept here so the message and the exit code that
 *  carries it stay in one place. */
export function refusalMessage(held: LockRecord | null, lockPath: string): string {
  const who = held
    ? `another run is already in progress (pid ${held.pid}, started ${held.startedAt}).\n  tenant: ${held.tenantDir}`
    : "another run holds the lock (its record was unreadable).";
  return [
    `confinement eval REFUSED: ${who}`,
    `  lock:   ${lockPath}`,
    "",
    "On 2026-08-23 two concurrent evals ran alongside live probe traffic and this host",
    "stopped scheduling userspace; it needed a console reboot. The exhausted resource was",
    "never captured, so concurrency is a contributor rather than a proven sole cause —",
    "this guard removes the one contributor it can.",
    "",
    "Wait for the running eval, or if you are certain it is dead, remove the lock file.",
  ].join("\n");
}
