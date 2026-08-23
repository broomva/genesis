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

describe("index.ts wires the voice channel into build() (BRO-2228 / BRO-2226)", () => {
  const call = buildCallSource();

  test.each(["voiceSecret", "voicePrincipals", "enqueueVoice", "voiceDelivery"])(
    "build() receives %s",
    (option) => {
      expect(call).toContain(option);
    },
  );

  test("the sink is the durable queue, not an inline throwaway", () => {
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(src).toContain("createVoiceQueue");
    expect(src).toContain("parseVoicePrincipals");
  });

  test("delivery stays OPT-IN: index.ts must not hardcode a delivery channel", () => {
    // Turning this on without a consumer draining the queue re-creates the
    // blocker: a caller told "I'll message you on WhatsApp" and nothing sends.
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(src).toContain("GENESIS_VOICE_DELIVERY");
    expect(src).not.toMatch(/voiceDelivery\s*[:=]\s*["']whatsapp["']/);
  });
});
