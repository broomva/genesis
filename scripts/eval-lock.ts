// Single-runner lock for the confinement eval (BRO-2245).
//
// WHY THIS EXISTS. On 2026-08-23 two confinement evals were started concurrently
// on srv1692698 alongside live probe traffic. Each eval spawns a series of real
// `claude` sessions against the deployed box; the host stopped scheduling
// userspace, the WhatsApp channel went silent for two real tenants, and recovery
// needed console access because every remote lever was already unreachable.
//
// WHAT IT CLAIMS. At most one eval process holds this path at a time. That is the
// whole contract.
//
// WHAT IT DOES NOT CLAIM. It does not bound tenant traffic or operator probes,
// which were also present during the incident, and the resource that actually ran
// out was never captured. It removes one contributor; it is not a proof against
// recurrence.
//
// ── THE DESIGN, AND WHY IT IS THIS SMALL ────────────────────────────────────
//
// Two earlier versions were rejected by cross-model review, and the second
// rejection is the instructive one.
//
// v1 read the path and then wrote it — a read-then-write TOCTOU. Two runners both
// observe "no lock", both write, both proceed.
//
// v2 fixed that with an O_EXCL create but kept a STALE-TAKEOVER path: if the
// recorded pid was dead, unlink the file and retry. That reintroduced races at a
// different layer, and they are not hypothetical:
//   - A and B both read a stale record. A unlinks and creates. B then unlinks
//     A's FRESH lock and creates its own. Both return acquired.
//   - Release read the record, confirmed the nonce, then unlinked — between those
//     two steps a takeover could replace the file, so release deleted the NEW
//     owner's lock.
//   - O_EXCL publishes the inode before the body is written, so a contender could
//     read a partial record, judge it corrupt, and unlink an ACTIVE writer's lock.
//   - A max-age expiry, added to bound pid reuse, steals from any eval that
//     legitimately runs longer than the age.
//
// Every one of those lives in the takeover path. Node and Bun expose no `flock`,
// so there is no kernel-held lock available here to make takeover atomic. So the
// takeover path is GONE rather than patched: this file no longer decides
// anything from the lock's CONTENTS.
//
// The single ordering point is `writeFileSync(path, body, { flag: "wx" })`, which
// Bun maps to O_CREAT|O_EXCL. Exactly one racer creates the file; every other gets
// EEXIST from the kernel. The file is read ONLY to tell an operator who holds it,
// and a read that fails or returns nonsense changes no decision.
//
// THE COST, STATED PLAINLY. A crashed or SIGKILLed eval leaves the lock behind and
// the next run refuses until someone removes it. That is a deliberate trade: a
// stuck lock is loud, visible, and fixed by one `rm`, whereas an automatic
// takeover is exactly the machinery that kept reintroducing concurrent runners —
// the failure this guard exists to prevent. The refusal message says so and names
// the file.
//
// EXIT SEMANTICS. Refusing exits 2, matching the file this guards:
// confinement-eval.ts already uses 2 for INVALID, on the rule that a run which
// could not measure is not a run that passed. A concurrent run cannot produce a
// trustworthy verdict either — it perturbs the very box it is measuring.

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

/** Recorded holder. Purely informational: nothing in acquisition reads it.
 *
 *  `nonce` is load-bearing in exactly one place — release. If an operator clears
 *  a stuck lock while its owner is somehow still alive and a new runner acquires,
 *  the old owner's exit handler must not delete the new owner's file. */
export interface LockRecord {
  readonly pid: number;
  readonly startedAt: string;
  readonly tenantDir: string;
  readonly nonce: string;
}

export type LockOutcome =
  | { readonly ok: true; readonly record: LockRecord }
  | { readonly ok: false; readonly heldBy: LockRecord | null };

/** Read a file, or null. Tolerates concurrent removal.
 *
 *  `existsSync` followed by `readFileSync` is itself a TOCTOU — the file can go
 *  away in between and throw ENOENT. Catching is the whole check. */
function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Parse a holder record for REPORTING only.
 *
 *  Returns null for absent, unparseable, or partially-written content. Because no
 *  acquisition decision consults this, a partial read is harmless here — under
 *  the v2 design the same null was a way in. */
export function parseRecord(raw: string | null): LockRecord | null {
  if (raw === null) return null;
  try {
    const r = JSON.parse(raw) as LockRecord;
    return typeof r?.pid === "number" && typeof r?.nonce === "string" ? r : null;
  } catch {
    return null;
  }
}

/** Advisory only: is the recorded pid currently running?
 *
 *  Shown to a human deciding whether a stuck lock is safe to remove. It is NOT
 *  consulted by `acquireEvalLock` — that is the v2 mistake, and pid reuse makes
 *  the answer unreliable in exactly the case where it would matter most.
 *
 *  EPERM means the process EXISTS but belongs to another user, so it counts as
 *  alive; only ESRCH means "no such process". */
export type Liveness = "alive" | "dead" | "unknown";

export function processLiveness(pid: number, kill: (p: number, s: number) => void): Liveness {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    kill(pid, 0);
    return "alive";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EPERM") return "alive";
    if (code === "ESRCH") return "dead";
    // Anything else — EINVAL, a platform quirk — is NOT evidence of death. The
    // earlier boolean collapsed every non-EPERM error into `false`, which let the
    // refusal message tell an operator "NOT running" on no evidence at all.
    return "unknown";
  }
}

export interface LockDeps {
  readFile?: (p: string) => string | null;
  /** MUST create exclusively and throw EEXIST if the path exists. */
  createExclusive?: (p: string, body: string) => void;
  /** Returns whether a file was actually removed. */
  remove?: (p: string) => boolean;
  pid?: number;
  now?: () => Date;
  nonce?: () => string;
}

/** Acquire, or report who holds it. One create attempt: no retry, no takeover.
 *
 *  Callers that get `ok: false` must NOT proceed. Callers that get `ok: true`
 *  must pass the returned record to `releaseEvalLock`. */
export function acquireEvalLock(
  lockPath: string,
  tenantDir: string,
  deps: LockDeps = {},
): LockOutcome {
  const readFile = deps.readFile ?? readOrNull;
  const createExclusive =
    deps.createExclusive ??
    ((p: string, body: string) => writeFileSync(p, body, { flag: "wx", mode: 0o644 }));
  const pid = deps.pid ?? process.pid;
  const now = deps.now ?? (() => new Date());
  const nonce = deps.nonce ?? (() => crypto.randomUUID());

  const record: LockRecord = {
    pid,
    startedAt: now().toISOString(),
    tenantDir,
    nonce: nonce(),
  };

  try {
    createExclusive(lockPath, `${JSON.stringify(record, null, 2)}\n`);
    return { ok: true, record };
  } catch (err) {
    // Only EEXIST means "someone else holds it". Anything else — ENOSPC, EACCES,
    // a read-only mount — must propagate: swallowing it would let a run proceed
    // believing it holds a lock that was never created.
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    return { ok: false, heldBy: parseRecord(readFile(lockPath)) };
  }
}

/** Release, but only if the lock still names us.
 *
 *  Returns whether a file was actually removed — including `false` when the
 *  unlink itself failed, so the return value never overstates what happened.
 *
 *  RESIDUAL WINDOW, AND WHY THE PROCEDURE CLOSES IT. Read-then-unlink cannot be
 *  made atomic without a kernel-held lock, which Node and Bun do not expose. So
 *  this sequence is possible IN PRINCIPLE: we read and match our nonce, an
 *  operator removes our file, another runner acquires, and our unlink then
 *  deletes THEIRS.
 *
 *  Every step of that requires us to still be RUNNING when the operator removes
 *  our lock. That is why the refusal message tells the operator to kill the
 *  holding pid FIRST and remove the file SECOND: after the kill there is no
 *  process left to reach the unlink, so the window does not exist in the
 *  supported procedure. An operator who removes the file out from under a live
 *  run is outside it, and no path-based scheme can defend that case. */
export function releaseEvalLock(
  lockPath: string,
  record: LockRecord | null,
  deps: Pick<LockDeps, "readFile" | "remove"> = {},
): boolean {
  if (!record) return false;
  const readFile = deps.readFile ?? readOrNull;
  const remove =
    deps.remove ??
    ((p: string) => {
      try {
        unlinkSync(p);
        return true;
      } catch {
        // Best effort: a failed unlink must not turn a completed eval into a
        // failed one. It is reported, not thrown.
        return false;
      }
    });

  const held = parseRecord(readFile(lockPath));
  if (held?.nonce !== record.nonce) return false;
  return remove(lockPath);
}

/** POSIX single-quoting, so a lock path from GENESIS_EVAL_LOCK containing spaces
 *  or shell syntax is safe to paste. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Operator-facing refusal text. Kept beside the code so the message and the exit
 *  code that carries it cannot drift apart. */
export function refusalMessage(
  held: LockRecord | null,
  lockPath: string,
  liveness?: (pid: number) => Liveness,
): string {
  const lines = ["confinement eval REFUSED: another run holds the lock.", `  lock:   ${lockPath}`];
  if (held) {
    lines.push(
      `  pid:    ${held.pid}`,
      `  since:  ${held.startedAt}`,
      `  tenant: ${held.tenantDir}`,
    );
    if (liveness) {
      const l = liveness(held.pid);
      lines.push(
        l === "alive"
          ? "  status: that pid is RUNNING — wait for it."
          : l === "dead"
            ? "  status: that pid is not running; the run probably crashed."
            : "  status: could not determine whether that pid is running.",
      );
    }
  } else {
    lines.push("  (the holder's record was unreadable — it may be mid-write.)");
  }
  lines.push(
    "",
    "There is no automatic takeover, on purpose: every version of this guard that",
    "reclaimed a stale lock automatically reintroduced concurrent runners, which is",
    "the failure it exists to prevent. A stuck lock is loud and recovering is two",
    "commands.",
    "",
    "RECOVER IN THIS ORDER — the kill must come first. Removing the file while the",
    "holder is still alive lets its exit handler delete the NEXT runner's lock:",
  );
  if (held) lines.push(`  kill ${held.pid}   # or: kill -9 ${held.pid}`);
  lines.push(`  rm -- ${shellQuote(lockPath)}`);
  return lines.join("\n");
}
