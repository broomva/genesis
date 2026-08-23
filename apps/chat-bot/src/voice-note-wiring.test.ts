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
    expect(index).toMatch(/findVoiceNote|resolveVoiceNote/);
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

  test("a refusal is POSTED, never merely logged", () => {
    // The whole point of the module is that no path is silent. If the entrypoint
    // logged the reason and returned, the sender would still see nothing.
    expect(index).toMatch(/outcome\.reply|\.post\(outcome/);
  });

  test("the transcriber binding exists so a backend can be plugged in", () => {
    expect(index).toMatch(/transcriber(\s*:\s*Transcriber\s*\|\s*undefined)?\s*=/);
  });
});
