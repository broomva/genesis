import { describe, expect, test } from "bun:test";

/** Wiring guard (BRO-2266), same shape as operator-order.test.ts.
 *
 *  BRO-2228 shipped a whole surface — routes, options, 25 green tests — that no
 *  entrypoint ever passed, so `if (opts.voiceSecret)` never ran and no caller
 *  could reach it. Unit tests cannot catch that: they construct the call
 *  themselves. These assertions read the ENTRYPOINT and check the path exists
 *  there. */
const index = await Bun.file(new URL("./index.ts", import.meta.url)).text();

describe("voice notes are reachable from the entrypoint", () => {
  test("the resolver is imported", () => {
    expect(index).toContain('from "./voice-note"');
    expect(index).toMatch(/textToDispatch/);
  });

  test("EVERY dispatch site goes through textToDispatch, not message.text", () => {
    // The defect this prevents: wiring one of the three callbacks and leaving
    // the others on message.text, so voice notes work in DMs and vanish in
    // groups. A fix at two call sites tested at one is a recurring failure here.
    const dispatches = index.match(/await handleAgentMessage\([^)]*\)/g) ?? [];
    expect(dispatches.length).toBeGreaterThanOrEqual(3);
    for (const d of dispatches) {
      expect(d).not.toContain("message.text");
    }
  });

  // NOTE: "a refusal is actually posted" is deliberately NOT asserted here.
  // It was, by grepping this file for a substring — and the mutation sweep
  // showed that a no-op still mentioning `outcome.reply` SURVIVED it. The
  // behaviour moved into voice-note.ts precisely so a real test could drive it
  // with a recording thread; see "the refusal actually reaches the sender".
  // Keeping a grep alongside that real test would be a weaker second gate.

  test("the transcriber binding exists and is PASSED, not just declared", () => {
    // BRO-2228's defect exactly: options declared on a surface and supplied by
    // nothing, so the branch behind them never ran in any deploy.
    expect(index).toMatch(/transcriber(\s*:\s*Transcriber\s*\|\s*undefined)?\s*=/);
    expect(index).toContain("textToDispatch(thread, message, transcriber)");
  });
});
