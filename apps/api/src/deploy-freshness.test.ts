// BEHAVIOURAL tests for scripts/deploy-freshness.sh.
//
// The first version of this file was a grep over the script's text. A sweep put
// 15 wrong implementations past it and 12 survived — including dropping two of
// the three units, inverting the currency comparison, and wrapping the entire
// section in `if false &&`. Worse, the test that claimed to check "every unit"
// was satisfied by the PROSE naming those units, so the comment explaining the
// fix satisfied the check for the fix.
//
// So this runs the real script against fixture repos with a shimmed `systemctl`
// and asserts on its exit code and output. Every case below is a state the
// deployed host has actually been in, or one commit away from it.

import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../../..", import.meta.url).pathname;
const SCRIPT = join(ROOT, "scripts/deploy-freshness.sh");
const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

const sh = (cmd: string[], cwd: string, env: Record<string, string> = {}) =>
  Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env } });

/** Built ONCE. Re-running `git init` + commit + bare-init + push per test made
 *  the suite take ~5s a case and blow bun's default timeout: 6 of 8 runs failed,
 *  which is a flaky detector-test — worse than no test. Each fixture is now a
 *  copy of this template, and the copy re-points `origin` at its own bare repo. */
let TEMPLATE: string | null = null;
function buildTemplate(): string {
  const dir = mkdtempSync(join(tmpdir(), "fresh-tpl-"));
  temps.push(dir);
  const repo = join(dir, "repo");
  const origin = join(dir, "origin.git");
  mkdirSync(repo, { recursive: true });
  sh(["git", "init", "-q", "-b", "main", "."], repo);
  sh(["git", "config", "user.email", "t@t"], repo);
  sh(["git", "config", "user.name", "t"], repo);
  for (const p of ["apps/api", "apps/chat-bot", "apps/web", "packages"]) {
    mkdirSync(join(repo, p), { recursive: true });
    writeFileSync(join(repo, p, "f.ts"), "export const x = 1;\n");
  }
  mkdirSync(join(repo, "apps/web/.next"), { recursive: true });
  writeFileSync(join(repo, "apps/web/.next/BUILD_ID"), "build-1\n");
  sh(["git", "add", "-A"], repo);
  // Dated, so a fixture can place a unit's start BETWEEN this commit and a later
  // one — the only way to tell a per-path comparison from a whole-repo one. With
  // every start in the far future both implementations agree.
  sh(
    ["git", "commit", "-qm", "base"],
    repo,
    {
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    },
    30_000,
  );
  sh(["git", "init", "-q", "--bare", origin], dir);
  sh(["git", "remote", "add", "origin", origin], repo);
  sh(["git", "push", "-q", "origin", "main"], repo);
  sh(["git", "fetch", "-q", "origin"], repo);
  return dir;
}

function fixtureRepo(): string {
  TEMPLATE ??= buildTemplate();
  const dir = mkdtempSync(join(tmpdir(), "fresh-"));
  temps.push(dir);
  cpSync(TEMPLATE, dir, { recursive: true });
  const repo = join(dir, "repo");
  // the copied remote still points at the TEMPLATE's bare repo
  sh(["git", "remote", "set-url", "origin", join(dir, "origin.git")], repo);
  const future = Date.now() / 1000 + 60;
  utimesSync(join(repo, "apps/web/.next/BUILD_ID"), future, future);
  return repo;
}

/** A `systemctl` shim. `spec` maps unit -> state, or omits a unit entirely. */
function shimBin(spec: Record<string, string | null>, startedAt: string): string {
  const dir = mkdtempSync(join(tmpdir(), "shim-"));
  temps.push(dir);
  const cases = Object.entries(spec)
    .map(([u, state]) =>
      state === null
        ? `    ${u}.service) exit 1 ;;`
        : `    ${u}.service) if [ "$MODE" = cat ]; then exit 0; elif [ "$PROP" = ActiveState ]; then echo "${state}"; else echo "${startedAt}"; fi; exit 0 ;;`,
    )
    .join("\n");
  writeFileSync(
    join(dir, "systemctl"),
    `#!/usr/bin/env bash
# shim: systemctl --user cat|show <unit> [-p PROP --value]
MODE=""; UNIT=""; PROP=""
for a in "$@"; do
  case "$a" in
    cat|show) MODE="$a" ;;
    *.service) UNIT="$a" ;;
    ActiveState|ActiveEnterTimestamp) PROP="$a" ;;
  esac
done
case "$UNIT" in
${cases}
    *) exit 1 ;;
esac
`,
  );
  chmodSync(join(dir, "systemctl"), 0o755);
  return dir;
}

const ALL_UP = { "genesis-api": "active", "genesis-bot": "active", "genesis-web": "active" };
/** systemd's own rendering, well after any fixture commit. */
const STARTED_LATE = "Mon 2099-01-01 00:00:00 UTC";
const STARTED_EARLY = "Mon 2000-01-01 00:00:00 UTC";

function run(repo: string, bin: string) {
  const r = Bun.spawnSync(
    ["bash", SCRIPT],
    {
      cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPO_DIR: repo, SKIP_FETCH: "1" },
    },
    30_000,
  );
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

describe("deploy-freshness (behavioural)", () => {
  test("a healthy host passes every claim", () => {
    const r = run(fixtureRepo(), shimBin(ALL_UP, STARTED_LATE));
    expect(r.out).toContain("genesis-api started after");
    expect(r.out).toContain("genesis-bot started after");
    expect(r.out).toContain("genesis-web started after");
    expect(r.out).toContain("build is newer");
    expect(r.code).toBe(0);
  });

  test("a unit that is NOT active fails — it used to read as fresh", () => {
    // The defect this replaces: `date -d ""` returns today-at-midnight with exit
    // 0, so a never-started unit compared as newer than every source commit. The
    // bug was ANTI-correlated with the fault — the longer it had been down, the
    // more confidently it reported current.
    const r = run(fixtureRepo(), shimBin({ ...ALL_UP, "genesis-bot": "activating" }, ""));
    expect(r.out).toContain("genesis-bot is active");
    expect(r.out).toContain("activating");
    expect(r.code).toBe(1);
  });

  test("a MISSING unit fails rather than vanishing", () => {
    // It used to `continue`, so a renamed or uninstalled unit disappeared from
    // the output while the summary went on claiming the host was current.
    const r = run(fixtureRepo(), shimBin({ ...ALL_UP, "genesis-web": null }, STARTED_LATE));
    expect(r.out).toContain("genesis-web is installed");
    expect(r.out).toContain("no such unit");
    expect(r.code).toBe(1);
  });

  test("a unit started BEFORE its sources changed fails", () => {
    const r = run(fixtureRepo(), shimBin(ALL_UP, STARTED_EARLY));
    expect(r.out).toContain("pulled, never restarted");
    expect(r.code).toBe(1);
  });

  test("a DIRTY tree fails — 'at origin/main' used to be green on it", () => {
    const repo = fixtureRepo();
    writeFileSync(join(repo, "apps/api/f.ts"), "export const x = 2; // hotfixed in place\n");
    const r = run(repo, shimBin(ALL_UP, STARTED_LATE));
    expect(r.out).toContain("checkout is clean");
    expect(r.out).toContain("edited in place");
    expect(r.code).toBe(1);
  });

  test("a checkout AHEAD of origin/main fails — divergence is not currency", () => {
    const repo = fixtureRepo();
    writeFileSync(join(repo, "apps/api/g.ts"), "export const y = 1;\n");
    sh(["git", "add", "-A"], repo);
    sh(["git", "commit", "-qm", "unpushed hotfix"], repo);
    const r = run(repo, shimBin(ALL_UP, STARTED_LATE));
    expect(r.out).toContain("diverged from main");
    expect(r.code).toBe(1);
  });

  test("a MISSING web build fails — absence is the condition under test", () => {
    const repo = fixtureRepo();
    rmSync(join(repo, "apps/web/.next/BUILD_ID"));
    const r = run(repo, shimBin(ALL_UP, STARTED_LATE));
    expect(r.out).toContain("apps/web has a build to serve");
    expect(r.code).toBe(1);
  });

  test("a STALE web build fails even when the unit restarted", () => {
    // web serves a built artifact, so a restart without a rebuild is current by
    // every process-level check and still serving old code.
    const repo = fixtureRepo();
    utimesSync(join(repo, "apps/web/.next/BUILD_ID"), 1000, 1000);
    const r = run(repo, shimBin(ALL_UP, STARTED_LATE));
    expect(r.out).toContain("older than its last source commit");
    expect(r.code).toBe(1);
  });

  test("the FETCH actually updates origin/main", () => {
    // Without a fetch, `HEAD..origin/main` counts against a stale local ref and a
    // behind host UNDER-reports its own staleness — measured on the real host the
    // same minute: 12 commits behind before a fetch, 16 after. A `--dry-run` or
    // tags-only fetch is the same lie in the same reassuring direction, so this
    // runs the real network path against a LOCAL bare origin (no network needed)
    // and requires the resulting count to be right.
    const repo = fixtureRepo();
    // advance origin behind the checkout's back, exactly as a merge to main does
    const clone = mkdtempSync(join(tmpdir(), "push-"));
    temps.push(clone);
    sh(["git", "clone", "-q", join(repo, "..", "origin.git"), "c"], clone);
    const c = join(clone, "c");
    sh(["git", "config", "user.email", "t@t"], c);
    sh(["git", "config", "user.name", "t"], c);
    writeFileSync(join(c, "apps/api/new.ts"), "export const z = 1;\n");
    sh(["git", "add", "-A"], c);
    sh(["git", "commit", "-qm", "landed on main"], c);
    sh(["git", "push", "-q", "origin", "main"], c);

    // SKIP_FETCH left unset: the script must fetch and SEE the new commit.
    const bin = shimBin(ALL_UP, STARTED_LATE);
    const r = Bun.spawnSync(["bash", SCRIPT], {
      cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPO_DIR: repo },
    });
    const out = r.stdout.toString() + r.stderr.toString();
    expect(out).toContain("1 commits behind");
    expect(r.exitCode).toBe(1);
  });

  test("staleness is judged per unit, against ITS OWN paths", () => {
    // Comparing every unit to the whole repo (or to HEAD) marks all three stale
    // whenever any one app changes. Over-reporting is the bias that gets
    // detectors ignored, so this pins the discrimination: touch apps/api only,
    // start api BEFORE that commit and the others after.
    const repo = fixtureRepo();
    writeFileSync(join(repo, "apps/api/f.ts"), "export const x = 3;\n");
    sh(["git", "add", "-A"], repo);
    sh(["git", "commit", "-qm", "api only"], repo);
    sh(["git", "push", "-q", "origin", "main"], repo);
    sh(["git", "fetch", "-q", "origin"], repo);

    const bin = mkdtempSync(join(tmpdir(), "shim2-"));
    temps.push(bin);
    writeFileSync(
      join(bin, "systemctl"),
      `#!/usr/bin/env bash
MODE=""; UNIT=""; PROP=""
for a in "$@"; do
  case "$a" in
    cat|show) MODE="$a" ;;
    *.service) UNIT="$a" ;;
    ActiveState|ActiveEnterTimestamp) PROP="$a" ;;
  esac
done
[ "$MODE" = cat ] && exit 0
if [ "$PROP" = ActiveState ]; then echo active; exit 0; fi
# api started long ago; bot and web started far in the future
case "$UNIT" in
  genesis-api.service) echo "Mon 2000-01-01 00:00:00 UTC" ;;
  *) echo "Mon 2021-01-01 00:00:00 UTC" ;;
esac
`,
    );
    chmodSync(join(bin, "systemctl"), 0o755);
    const r = run(repo, bin);
    expect(r.out).toContain("genesis-api is running its current sources"); // FAILS
    expect(r.out).toContain("genesis-bot started after"); // passes
    expect(r.out).toContain("genesis-web started after"); // passes
    expect(r.code).toBe(1);
  });

  test("off the deployed host it DECLINES (exit 2), never passes", () => {
    // The checkout in scope would be the developer's; measuring it answers about
    // the wrong machine in the reassuring direction.
    // A machine WITH systemd but without the genesis units — a Linux dev box,
    // which is the realistic shape. (Blanking PATH entirely would only prove
    // that bash is missing.)
    const bin = shimBin(
      { "genesis-api": null, "genesis-bot": null, "genesis-web": null },
      STARTED_LATE,
    );
    const r = run(fixtureRepo(), bin);
    expect(r.out).toContain("NOT assessed");
    expect(r.code).toBe(2);
    // and it must NOT have reported on any unit
    expect(r.out).not.toContain("started after");
  }, 30_000);
});
