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
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
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
