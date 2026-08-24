import { describe, expect, test } from "bun:test";
// Behavioural test for scripts/genesis-funnel-guard.sh (BRO-2274).
//
// WHY A TEST FOR AN OPS SCRIPT. This guard restarts tailscaled — the daemon its own
// SSH runs over — on a heuristic read of an HTTP status code. It got that read wrong
// once and converted a 96-second backend restart into a total ingress outage. It also
// lived only at /usr/local/bin on one box, so nothing reviewed it and nothing could
// have caught the misclassification.
//
// The script is driven with STUBBED curl/dig/systemctl on PATH, so each status code
// is exercised end to end and "did it restart tailscaled" is observed rather than
// reasoned about.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(import.meta.dir, "genesis-funnel-guard.sh");

/** The guard uses `mapfile`, a bash 4+ builtin. macOS ships bash 3.2 at /bin/bash,
 *  where the script exits before printing anything — which would make every
 *  assertion below fail for a reason that has nothing to do with the guard. Pick a
 *  modern bash explicitly, and if there is none, FAIL LOUDLY rather than skip: a
 *  silently-skipped suite on a script that restarts tailscaled is worse than a red
 *  one. CI runs Linux, where /bin/bash is 5.x. */
function modernBash(): string {
  for (const c of ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/bin/bash"]) {
    try {
      // Bun.spawnSync THROWS on a missing executable rather than returning a
      // non-zero exit, so an absent candidate must be caught, not tested. CI is
      // Linux and has no /opt/homebrew/bash — the uncaught throw took the whole
      // suite down there while passing locally on macOS.
      const v = Bun.spawnSync([c, "-c", "echo ${BASH_VERSINFO[0]}"]);
      if (v.exitCode === 0 && Number(v.stdout.toString().trim()) >= 4) return c;
    } catch {
      // candidate not installed — try the next
    }
  }
  throw new Error(
    "no bash >= 4 found; the guard uses `mapfile`. Install bash 5 (brew install bash) to run this suite.",
  );
}
const BASH = modernBash();

/** Run the guard with curl forced to return `code`. Returns stdout + whether it
 *  attempted `systemctl restart tailscaled`. */
function runGuard(
  code: string,
  opts: {
    postRestartCode?: string;
    sequence?: string[];
    stateDir?: string;
    localCode?: string;
    budget?: string;
  } = {},
) {
  const box = mkdtempSync(join(tmpdir(), "funnel-guard-"));
  const bin = join(box, "bin");
  mkdirSync(bin, { recursive: true });
  const restartLog = join(box, "restarts.log");

  // One public A record, so the "cannot measure" early exit is not taken.
  writeFileSync(join(bin, "dig"), '#!/usr/bin/env bash\necho "203.0.113.10"\n');
  // First probe returns `code`; any later probe (the post-restart loop) returns
  // postRestartCode, defaulting to the same thing.
  // The stub must distinguish the two probes, because the decision is now the
  // COMPARISON between them rather than a reading of either code alone.
  //   public: https://<host>:<port><path>   local: http://127.0.0.1:8788<path>
  const seq = opts.sequence ?? [code, opts.postRestartCode ?? code];
  const localCode = opts.localCode ?? "405"; // backend answering, unless stated
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash
for a in "$@"; do case "$a" in http://127.0.0.1:*) printf '%s' '${localCode}'; exit 0;; esac; done
n=$(cat "${box}/probes" 2>/dev/null || echo 0)
echo $((n+1)) > "${box}/probes"
codes=(${seq.map((c) => `'${c}'`).join(" ")})
i=$n
[ "$i" -ge ${seq.length} ] && i=$(( ${seq.length} - 1 ))
printf '%s' "${"${codes[$i]}"}"
`,
  );
  writeFileSync(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash\necho "$@" >> "${restartLog}"\nexit 0\n`,
  );
  // The script sleeps 20s after a restart; keep the test fast.
  writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  for (const f of ["dig", "curl", "systemctl", "sleep"]) chmodSync(join(bin, f), 0o755);

  const p = Bun.spawnSync([BASH, GUARD], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      GENESIS_FUNNEL_STATE_DIR: opts.stateDir ?? join(box, "state"),
      GENESIS_FUNNEL_COOLDOWN: "0", // never let cooldown mask a restart decision
      // 2s of wall clock: `sleep` is stubbed instant, so this allows several retry
      // rounds while keeping the suite fast. The deadline is wall-clock by design.
      GENESIS_FUNNEL_POST_RESTART_BUDGET: opts.budget ?? "2",
    },
  });
  let restarts = "";
  try {
    restarts = readFileSync(restartLog, "utf8");
  } catch {
    /* no restart attempted */
  }
  return {
    stdout: p.stdout.toString(),
    exitCode: p.exitCode,
    restartedTailscaled: restarts.includes("restart tailscaled"),
  };
}

describe("funnel guard — decision table (BRO-2274)", () => {
  // THE DECISION IS A COMPARISON, NOT A CODE LOOKUP. Two review rounds each found a
  // new status code the previous revision mishandled — 000, then 502, then whatever a
  // backend starts answering next. So these assert over the PAIR (public, local), and
  // the public code is deliberately varied across values the script has never seen.
  test.each(["405", "401"])("public %s = serving → no action", (code) => {
    const r = runGuard(code);
    expect(r.stdout).toContain("funnel is published and serving");
    expect(r.restartedTailscaled).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  // THE ORIGINAL INCIDENT. Backend down for a deploy, public returns 502 — the
  // failure is explained without implicating the funnel, so a tailscaled restart
  // cannot help and previously made it worse (502 became 000).
  test.each(["502", "503", "504", "000", "404", "200"])(
    "public %s + local DOWN → backend fault, no restart",
    (code) => {
      const r = runGuard(code, { localCode: "000" });
      expect(r.restartedTailscaled).toBe(false);
      expect(r.stdout).toContain("NOT restarting tailscaled; fix the backend");
      expect(r.exitCode).toBe(1);
    },
  );

  // THE INVERSE, and the reason this is a comparison rather than an allowlist: the
  // SAME public code with a healthy backend means the public path really is broken.
  // Under the previous revision a 502 here was unconditionally excused.
  test.each(["502", "503", "000", "404", "200", "418"])(
    "public %s + local HEALTHY → funnel fault, restarts",
    (code) => {
      const r = runGuard(code, { localCode: "405", postRestartCode: "405" });
      expect(r.stdout).toContain("the public path is the fault");
      expect(r.restartedTailscaled).toBe(true);
    },
  );

  test("a funnel that recovers on a LATER round is RECOVERED, not escalated", () => {
    const r = runGuard("000", { sequence: ["000", "000", "000", "405"], localCode: "405" });
    expect(r.restartedTailscaled).toBe(true);
    expect(r.stdout).toContain("funnel RECOVERED after restart");
    expect(r.stdout).not.toContain("needs a human");
    expect(r.exitCode).toBe(0);
  });

  test("a funnel that never comes back DOES still escalate", () => {
    const r = runGuard("000", { sequence: ["000"], localCode: "405" });
    expect(r.restartedTailscaled).toBe(true);
    expect(r.stdout).toContain("needs a human");
    expect(r.exitCode).toBe(1);
  });

  // The post-restart loop used to check only 405/401, so a backend that died during
  // the restart window was escalated to a human — the same conflation, one branch
  // away from where it had been fixed.
  test("a backend that dies DURING the restart window is not escalated", () => {
    const r = runGuard("000", { sequence: ["000"], localCode: "000" });
    // local down at the first check → refuses before restarting at all
    expect(r.restartedTailscaled).toBe(false);
    expect(r.stdout).not.toContain("needs a human");
  });

  // Non-numeric config made `[ "$waited" -ge "abc" ]` fail without aborting under
  // `set -uo pipefail`, so the retry loop never terminated — a hang inside a systemd
  // oneshot, which is worse than a wrong answer because nothing after it runs.
  // A non-numeric budget reached `$(( ... + POST_RESTART_BUDGET ))` and ABORTED the
  // script under `set -u` — output stopped mid-run with no verdict at all. (Before
  // that it made `[ -ge "abc" ]` fail without terminating, spinning forever inside a
  // systemd oneshot.) The property asserted here is that it neither aborts nor hangs:
  // the run reaches the post-restart phase and reports a verdict.
  test("a non-numeric budget neither aborts nor hangs the run", () => {
    const r = runGuard("000", { sequence: ["000", "405"], localCode: "405", budget: "abc" });
    expect(r.stdout).toContain("post-restart ingress");
    expect(r.stdout).toContain("funnel RECOVERED after restart");
    expect(r.exitCode).toBe(0);
  });

  test("no public A record → cannot measure, takes no action", () => {
    const box = mkdtempSync(join(tmpdir(), "funnel-guard-dns-"));
    const bin = join(box, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "dig"), "#!/usr/bin/env bash\nexit 0\n"); // no output
    writeFileSync(join(bin, "systemctl"), `#!/usr/bin/env bash\necho "$@" >> ${box}/r.log\n`);
    for (const f of ["dig", "systemctl"]) chmodSync(join(bin, f), 0o755);
    const p = Bun.spawnSync([BASH, GUARD], {
      env: { PATH: `${bin}:/usr/bin:/bin`, GENESIS_FUNNEL_STATE_DIR: join(box, "state") },
    });
    expect(p.stdout.toString()).toContain("cannot measure, not acting");
    expect(p.exitCode).toBe(0);
  });
});
