import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// WHY A SOURCE-LEVEL TEST (P20 Strata A, round 1, MAJOR).
//
// Every other voice test calls build() and injects voiceSecret / voicePrincipals
// / enqueueVoice by hand. That is the shape of the bug this PR exists to fix:
// the surface was fully tested and passed all of it while `index.ts` handed
// build() none of those options, so `if (opts.voiceSecret)` never ran and the
// routes 404'd in every real deploy. Delete the wiring from index.ts today and
// all 25 injected-option tests stay green — the regression is invisible to them,
// because they supply the very precondition whose absence was the defect.
//
// So this asserts the ENTRYPOINT, not the server: the options must be passed
// inside the real build() call. Textual rather than behavioural because booting
// index.ts needs a pglite store, a port and a workspace root, which belongs in
// the deploy smoke rather than a unit suite — that boot was exercised by hand
// (both polarities: routes answer with the secret set, 404 without it).

/** The build({...}) argument object with COMMENTS STRIPPED.
 *
 *  Without the strip, `toContain("walkieSecret")` is satisfied by a comment that
 *  merely mentions the option — which is what happened: deleting all three
 *  walkie options from the call left one assertion passing, because the comment
 *  above them says "gates on walkieSecret being present". An assertion a
 *  sentence can satisfy is not pinning a binding. */
/**
 * RESIDUAL, stated rather than papered over. This is still a text match over
 * source, and a text match is a claim about a FILE. The review's proposed fix —
 * export a `buildOpts()` factory and assert `Object.hasOwn` on the returned
 * object — is categorically better, and it was tried and reverted: importing
 * anything from index.ts BOOTS THE SERVER (measured: 1227 ms, a listener, and a
 * pglite store constructed at import time). Dragging that into the shared
 * `bun test` process is the same hazard that took this suite from 0 to 126
 * failures when a module mock leaked across files.
 *
 * The correct fix is an `import.meta.main` guard on the entrypoint so importing
 * is side-effect-free. That changes the boot model and belongs in its own change
 * rather than smuggled into this ticket — tracked separately.
 *
 * Until then: comments AND string/template literals are stripped, which defeats
 * both bypasses found so far, and `scripts/mutation-sweep-walkie.sh` carries a
 * `walkie unwired from build()` mutant. Neither makes this airtight, and saying
 * so is better than implying it is.
 */
function withoutComments(src: string): string {
  return (
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      // AND string/template literals. Stripping comments alone was not enough: the
      // assertion is a text match over source, so ANY literal inside the call
      // satisfies it. Demonstrated by a reviewer with
      // `workspaceName: \`walkie wired: walkieSecret, askLog, askLogDir\`` and all
      // three real options deleted — green. Third time in this ticket that a
      // matcher was satisfied by prose rather than by code. (P20 MAJOR.)
      .replace(/`(?:[^`\\]|\\.)*`/g, "``")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  );
}

/** The literal argument object of the single build({...}) call in index.ts. */
function buildCallSource(): string {
  const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  const start = src.indexOf("build({");
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced build({ ... }) in index.ts");
}

describe("index.ts wires the voice channel into build() (BRO-2228)", () => {
  const call = buildCallSource();

  test.each(["voiceSecret", "voicePrincipals", "enqueueVoice"])("build() receives %s", (option) => {
    expect(call).toContain(option);
  });

  test("the sink is the durable queue, not an inline throwaway", () => {
    // Asserting the BINDING, not mere presence of the identifier: round 2 noted
    // that "contains createVoiceQueue" passes if the name appears anywhere at
    // all, including an unused import, so it did not actually pin the sink.
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(src).toMatch(/const\s+enqueueVoice\s*=[^;]*createVoiceQueue\(/);
    expect(src).toMatch(/const\s+voicePrincipals\s*=[^;]*parseVoicePrincipals\(/);
  });

  test("delivery cannot be claimed at all — by config OR by argument", () => {
    // Two designs were rejected here. An env string was an operator assertion;
    // a {channel, deliver} object was a function-shaped one, since `deliver` had
    // no call sites and a no-op still bought the promise. Neither the entrypoint
    // nor build() may name a delivery channel until a consumer exists.
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const server = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
    expect(src).not.toContain("GENESIS_VOICE_DELIVERY");
    expect(src).not.toContain("voiceDelivery");
    // The option itself must not exist on BuildOpts: a caller that can pass it
    // can claim the channel, which is exactly how the last design failed.
    expect(server).not.toMatch(/^\s*voiceDelivery\??:/m);
  });
});

// ── walkie (BRO-2387) ──────────────────────────────────────────────────────
//
// The same hole, and I dug it: build() accepted walkieSecret / askLog /
// askLogDir while index.ts passed none of them, so `if (opts.walkieSecret)`
// could never run and /walkie/asks and /walkie/answer did not exist in any real
// deploy — with 21 route tests green, because every one of them injects the
// options by hand. Exactly the shape the block above exists to prevent,
// reproduced two years of lessons later. So it gets the same source-level guard.

describe("index.ts wires walkie into build() (BRO-2387)", () => {
  const call = withoutComments(buildCallSource());

  test.each(["walkieSecret", "askLog", "askLogDir"])("build() receives %s", (option) => {
    // Comment-stripped, and matched as a property rather than a substring: the
    // first version of this passed on a comment mentioning the option name.
    expect(call).toMatch(new RegExp(`(^|[\\s,{])${option}\\s*[,:]`));
  });

  test("the store is the durable ask log, not an inline throwaway", () => {
    // The BINDING, not the identifier: "contains createAskLog" would pass on an
    // unused import, which round 2 of the voice work established does not pin
    // anything.
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(src).toMatch(/const\s+askLog\s*=[^;]*createAskLog\(/);
  });

  test("the ask log has its OWN directory, never the voice queue's", () => {
    // The two stores must not share a directory. If askLogDir were derived from
    // voiceQueueDir, an agent-originated ask would land beside caller-originated
    // intake keyed by an untrusted phone number — the merge AGENTS.md forbids.
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const m = src.match(/const\s+askLogDir\s*=([^;]*);/);
    expect(m).not.toBeNull();
    expect(m?.[1]).not.toContain("voiceQueueDir");
    expect(m?.[1]).not.toContain("GENESIS_VOICE_QUEUE_DIR");
  });

  test("the store is built ONLY when the channel is configured", () => {
    // An unconfigured deploy must not create a directory nothing will ever write
    // to — the same rule the voice queue follows one line above it.
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(src).toMatch(/const\s+askLog\s*=\s*walkieSecret\s*\?/);
  });
});

describe("the ask producer gap is declared, not silent (BRO-2387)", () => {
  test("the boot line says the producer is live, and the caveat is gone", () => {
    // A surface that answers 200 while being permanently empty reads as working.
    // If someone lands the producer, this test fails and they remove the caveat
    // deliberately rather than leaving a stale disclaimer behind.
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    // The caveat is GONE, deliberately, in the change that made it false
    // (BRO-2413). Asserting its ABSENCE as well as the new line's presence: a
    // stale caveat that outlives its condition is the defect this arc filed
    // three times, and "the string I expected is present" does not catch a
    // second, contradictory line left behind next to it.
    expect(src).not.toContain("no producer yet");
    expect(src).toContain("producer live");
  });

  test("PRODUCTION code calls askLog.append — the gap is closed", () => {
    // INVERTED, deliberately, by the change that closed the gap (BRO-2413).
    //
    // It was written the other way round — "nothing outside tests calls
    // askLog.append" — precisely so that landing a producer would turn it red and
    // force the caveat out with it. That is exactly what happened: this test was
    // the only failure in the suite when the producer landed. A declaration of a
    // temporary state is only honest if something breaks when the state ends.
    //
    // It now asserts the opposite, and still by GREPPING production sources
    // rather than by trusting a call in a test — 25 test call sites coexisted
    // with zero production ones for the whole of BRO-2387.
    const dir = join(import.meta.dir, "..", "..", "..");
    const out = Bun.spawnSync(
      [
        "grep",
        "-rn",
        "--include=*.ts",
        "-e",
        "onAsk",
        "-e",
        "createAskLog(",
        join(dir, "apps"),
        join(dir, "packages"),
      ],
      { cwd: dir },
    ).stdout.toString();
    const callers = out
      .split("\n")
      .filter((l) => l.trim() && !l.includes(".test.ts") && !l.includes("/node_modules/"));
    // server.ts derives Supervisor.onAsk from the store, so the append lives
    // there. At least one non-test caller is the whole point.
    // Grepping `onAsk` — the producer's wiring — rather than a particular spelling
    // of the append. The first version searched for `askLog.append` and the code
    // said `askLog?.append`, so the test failed for a reason unrelated to the
    // property: a grep is only as good as the string, and the string was mine.
    const wired = callers.filter((l) => l.includes("onAsk"));
    expect(wired.length).toBeGreaterThan(0);
    expect(wired.join("\n")).toContain("server.ts");
  });
});
