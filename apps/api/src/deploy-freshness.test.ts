// The freshness section of `scripts/deploy-probe.sh` makes two claims in prose
// that nothing else checks, and both fail in the REASSURING direction — which is
// the only direction that matters for a detector. So they are asserted here.
//
// This is a file-content test, and weaker than a behavioural one. The behavioural
// controls were run by hand on the deployed host: the real checkout reported
// "0 commits behind", a clone reset 5 commits back reported "5 commits behind"
// and exited 1, and running it from a laptop declined to answer instead of
// passing. What this file guards is that the mechanism those controls exercised
// is still present, because a well-meaning simplification of either one restores
// a silent false green.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const probe = readFileSync(resolve(ROOT, "scripts/deploy-probe.sh"), "utf8");

// Everything from the freshness banner to the summary.
const section = probe.slice(probe.indexOf("▶ deployment freshness"));

describe("deploy-probe freshness", () => {
  test("the section exists at all", () => {
    expect(probe).toContain("▶ deployment freshness");
    expect(section.length).toBeGreaterThan(200);
  });

  test("it FETCHES before counting how far behind it is", () => {
    // The load-bearing detail. `rev-list HEAD..origin/main` counts against the
    // LOCAL origin/main ref, so on a host that has not fetched, a stale
    // deployment under-reports its staleness. Measured on the deployed host the
    // same minute: 12 commits behind before the fetch, 16 after. Drop the fetch
    // and the probe still passes its own controls while lying about production.
    const fetchAt = section.indexOf('git -C "$RD" fetch');
    const countAt = section.indexOf("rev-list --count HEAD..origin/main");
    expect(fetchAt).toBeGreaterThan(-1);
    expect(countAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeLessThan(countAt);
  });

  test("it checks the RUNNING process, not only the checkout", () => {
    // A pull without a restart leaves the unit executing the code it loaded at
    // start time. Checkout currency and process currency fail independently, and
    // pull-without-restart is the likelier accident.
    expect(section).toContain("ActiveEnterTimestamp");
    expect(section).toContain("log -1 --format=%ct");
  });

  test("off the deployed host it DECLINES rather than passing", () => {
    // Run from a laptop the git checkout in scope is the developer's, not the
    // deployment's. Measuring it would answer about the wrong machine in the
    // reassuring direction, so the check must refuse — and the summary must not
    // imply a check that did not run.
    expect(section).toContain("FRESHNESS_ASSESSED");
    expect(section).toContain("freshness NOT assessed");
    expect(section).toContain("freshness unknown (not run on the deployed host)");
    // and the success line must be CONDITIONAL on it having run
    const summary = section.slice(section.indexOf('if [ "$FAILED" -eq 0 ]'));
    expect(summary).toContain('FRESHNESS_ASSESSED" -eq 1');
  });
});
