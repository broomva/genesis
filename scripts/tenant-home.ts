// Per-tenant HOME guards (BRO-2235).
//
// Extracted from the provisioner so they can be TESTED. A guard whose firing is
// never proven is the same failure this ticket exists to fix: #122 shipped a fully
// tested pure function with zero call sites, and it read as a working feature.
// These are the checks that stand between an operator flag and a broken tenant, so
// "it looked right" is not enough.
//
// The split of strictness is deliberate and is documented at each function: the
// RUNTIME (`tenantEnv`, in @genesis/runner) is fail-SAFE and never removes a working
// HOME, because an outage caused by our own strictness would be worse than the leak
// it prevents. THESE are fail-CLOSED, because refusing at provisioning time costs an
// operator one message and cannot take a live tenant down.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** FAIL-CLOSED, unlike the runtime. Refuse to hand a tenant a HOME that carries no
 *  credential — that tenant would answer every message with silence and nothing
 *  would report an error. */
export function assertCredentialed(home: string): void {
  const credential = join(home, ".claude", ".credentials.json");
  // A REGULAR, NON-EMPTY file. `existsSync` alone is satisfied by a directory or a
  // zero-byte placeholder (CodeRabbit) — either would pass a guard whose entire job
  // is to prove a usable credential is present, which is a fail-closed check that
  // fails open on the artifact it checks for.
  try {
    const st = statSync(credential);
    if (st.isFile() && st.size > 0) return;
  } catch {
    // fall through to the refusal
  }
  throw new Error(
    [
      `GENESIS_TENANT_PER_HOME=1 but ${credential} is missing, empty, or not a file.`,
      "A tenant with an uncredentialed HOME fails every turn, and `claude -p` exits 0 while",
      "doing it, so nothing would surface the breakage.",
      "Seed a credential there (or unset GENESIS_TENANT_PER_HOME) and re-run.",
    ].join("\n"),
  );
}

/** Claude Code's per-project transcript directory name: the absolute cwd with every
 *  non-alphanumeric character replaced by `-`. Verified against the live box, where
 *  `/home/agent/orchestrator-workspaces/573017758620` is stored as
 *  `-home-agent-orchestrator-workspaces-573017758620` and `/home/agent/.p20probe` as
 *  `-home-agent--p20probe` (the `.` collapses too, producing the double dash). */
export function projectSlug(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Transcript directories under `oldHome` that plausibly belong to this tenant.
 *
 *  MATCHING IS DELIBERATELY LOOSE, and that is the opposite bias from the
 *  confinement eval's sibling check — because the cost of each error is inverted
 *  here. There, a false positive invented a breach; the exact match was correct.
 *  Here a false NEGATIVE means we quietly decide a tenant has no history and then
 *  break its `--resume`, while a false positive only makes us refuse and ask a human.
 *  So this matches the exact slug OR any directory carrying the tenant's own
 *  basename, and over-refusing is the intended failure mode. */
export function agentStateUnder(oldHome: string, dir: string): string[] {
  const root = join(oldHome, ".claude", "projects");
  if (!existsSync(root)) return [];
  const slug = projectSlug(dir);
  const self = dir.split("/").filter(Boolean).pop() ?? "";
  try {
    return readdirSync(root).filter((e) => e === slug || (self.length > 0 && e.includes(self)));
  } catch {
    return [];
  }
}

/** FAIL-CLOSED. Activating a per-tenant HOME relocates where Claude Code looks for
 *  transcripts, and the print engine — the live one — pushes `--resume <id>`
 *  UNCONDITIONALLY (packages/runner/src/index.ts): there is no transcript-existence
 *  check on that path at all.
 *
 *  Measured on the box rather than assumed:
 *      claude -p --resume <id-not-under-this-HOME>
 *      -> "No conversation found with session ID: ..."   exit 1
 *
 *  So flipping this on for a tenant that already has history breaks EVERY
 *  subsequent turn for it. Both live tenants have such history today. Refusing and
 *  naming the move is the only option here that cannot be silently half-right — a
 *  migration that guessed the directory name wrong would report success and still
 *  break the tenant. */
export function assertNoStrandedAgentState(oldHome: string, tenantHome: string, dir: string): void {
  const stranded = agentStateUnder(oldHome, dir);
  if (stranded.length === 0) return;
  throw new Error(
    [
      `GENESIS_TENANT_PER_HOME=1 would strand existing agent state for ${dir}.`,
      "The print engine passes --resume unconditionally, so the next turn would fail",
      'with "No conversation found with session ID" (exit 1) — for every turn after.',
      "",
      "Move it, then re-run:",
      ...stranded.map(
        (e) =>
          `  mv ${join(oldHome, ".claude", "projects", e)} ${join(tenantHome, ".claude", "projects", e)}`,
      ),
    ].join("\n"),
  );
}

/** Is `child` the same path as, or inside, `parent`? Separator-aware, so
 *  `/a/bc` is NOT treated as inside `/a/b` — a bare `startsWith` says it is. */
export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** FAIL-CLOSED. The tenant's HOME must not live inside the tenant's own workspace.
 *
 *  THE HOLE THIS CLOSES was self-inflicted: the first version of this feature put
 *  the home at `<tenantDir>/home`. The tenant workspace is `root:agent 1775` — the
 *  tenant has GROUP WRITE on it — and the confinement deny rules are anchored
 *  specifically at `Edit|Write(//<tenantDir>/.claude/**)`. `<tenantDir>/home/.claude`
 *  does not match that pattern.
 *
 *  So a tenant could have pre-created `home/.claude/settings.json` and simply waited:
 *  the moment an operator set GENESIS_TENANT_PER_HOME=1, that file would become its
 *  session's USER-scope settings — the layer `tenant-deny-rules.ts` itself describes
 *  as merging "into EVERY Claude Code session". The tenant would be supplying the
 *  configuration meant to confine it, and the same directory would hold the
 *  credential we put there.
 *
 *  Checked rather than merely relocated, because the location is one `join()` away
 *  from being wrong again and nothing else would notice. */
export function assertHomeOutsideTenant(tenantHome: string, tenantDir: string): void {
  if (!isInside(tenantDir, tenantHome)) return;
  throw new Error(
    [
      `Refusing a tenant HOME inside the tenant's own workspace: ${tenantHome} is under ${tenantDir}.`,
      "The workspace is group-writable by the tenant (root:agent 1775) and the confinement",
      "deny rules only anchor `<tenantDir>/.claude/**`, so the tenant could supply its own",
      "user-scope settings — and read the credential placed beside them.",
      "Put the home outside the workspace (see GENESIS_TENANT_HOMES_DIR).",
    ].join("\n"),
  );
}
