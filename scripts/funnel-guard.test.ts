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
function runGuard(code: string, opts: { postRestartCode?: string; sequence?: string[] } = {}) {
  const box = mkdtempSync(join(tmpdir(), "funnel-guard-"));
  const bin = join(box, "bin");
  mkdirSync(bin, { recursive: true });
  const restartLog = join(box, "restarts.log");

  // One public A record, so the "cannot measure" early exit is not taken.
  writeFileSync(join(bin, "dig"), '#!/usr/bin/env bash\necho "203.0.113.10"\n');
  // First probe returns `code`; any later probe (the post-restart loop) returns
  // postRestartCode, defaulting to the same thing.
  // A SEQUENCE, so a funnel that recovers on a later probe round can be modelled.
  // The last entry repeats forever, which is what makes "never recovers" expressible.
  const seq = opts.sequence ?? [code, opts.postRestartCode ?? code];
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash
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
      GENESIS_FUNNEL_STATE_DIR: join(box, "state"),
      GENESIS_FUNNEL_COOLDOWN: "0", // never let cooldown mask a restart decision
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

describe("funnel guard — classification (BRO-2274)", () => {
  test.each(["405", "401"])("%s = published and serving → no action", (code) => {
    const r = runGuard(code);
    expect(r.stdout).toContain("funnel is published and serving");
    expect(r.restartedTailscaled).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  // THE REGRESSION. A 502 can only come FROM the ingress — TLS terminated, serve
  // rule matched, backend dialled and refused — so it is proof the funnel IS
  // published. Restarting tailscaled here is what turned a 96s backend restart into
  // a total outage on 2026-08-24.
  test.each(["502", "503", "504"])("%s = ingress up, backend down → NO restart", (code) => {
    const r = runGuard(code);
    expect(r.restartedTailscaled).toBe(false);
    expect(r.stdout).toContain("NOT restarting tailscaled");
    expect(r.stdout).not.toContain("UNHEALTHY on every public ingress");
    expect(r.exitCode).toBe(1); // advisory failure — visible in the journal
  });

  // The original purpose must still work: an ingress that is genuinely not serving
  // produces 000, and that IS worth a restart.
  test("000 = ingress not serving → restarts tailscaled", () => {
    const r = runGuard("000", { postRestartCode: "405" });
    expect(r.restartedTailscaled).toBe(true);
    expect(r.stdout).toContain("UNHEALTHY on every public ingress");
    expect(r.stdout).toContain("funnel RECOVERED after restart");
    expect(r.exitCode).toBe(0);
  });

  test("an unrecognised code is still treated as not-serving (fails safe)", () => {
    const r = runGuard("418");
    expect(r.restartedTailscaled).toBe(true);
  });

  // THE SECOND DEFECT from the same incident. The restart at 05:02:46 WORKED, but the
  // single probe round 35s later still read 000, so the guard logged "needs a human"
  // on its own successful heal — and the next tick, untouched, read 405. Re-registering
  // with the Funnel ingress takes longer than 20s.
  test("a funnel that recovers on a LATER round is reported RECOVERED, not escalated", () => {
    // probe 1: initial 000 (triggers restart). probes 2-3: still coming up. then 405.
    const r = runGuard("000", { sequence: ["000", "000", "000", "405"] });
    expect(r.restartedTailscaled).toBe(true);
    expect(r.stdout).toContain("funnel RECOVERED after restart");
    expect(r.stdout).not.toContain("needs a human");
    expect(r.exitCode).toBe(0);
  });

  test("a funnel that never comes back DOES still escalate", () => {
    // Polarity partner: the retry must not turn a real failure into silence.
    const r = runGuard("000", { sequence: ["000"] });
    expect(r.restartedTailscaled).toBe(true);
    expect(r.stdout).toContain("needs a human");
    expect(r.exitCode).toBe(1);
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
