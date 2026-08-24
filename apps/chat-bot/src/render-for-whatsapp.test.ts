import { describe, expect, it } from "bun:test";
import { CHUNK_TARGET, chunkForWhatsapp, renderForWhatsapp } from "./handler";
import {
  FENCE_OVERHEAD,
  balanceFences,
  markdownToWhatsApp,
  residualMarkdown,
} from "./whatsapp-format";

const L = { label: "thread=t-1", warn: () => {} };

// A refactor that changes delivery is a regression, not a cleanup. So the
// contract pinned first is EQUIVALENCE with the sequence this replaced.
const inputs = [
  "short reply",
  "## Heading\n\n**bold** and a [link](https://example.com/x)",
  "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |",
  "```python\ndef f(*a, **kw):\n    return kw\n```",
  `a long one: ${"lorem ipsum dolor sit amet. ".repeat(120)}`,
  `fenced and long:\n\`\`\`\n${"x = 1\n".repeat(300)}\`\`\`\ntrailing prose`,
  "",
  "• *already converted* — run `/parallax`",
];

describe("renderForWhatsapp — equivalent to the sequence it replaces", () => {
  for (const [i, text] of inputs.entries()) {
    it(`case ${i}: chunks match the inline pipeline`, () => {
      const expected = balanceFences(
        chunkForWhatsapp(markdownToWhatsApp(text), CHUNK_TARGET - FENCE_OVERHEAD),
      );
      expect(renderForWhatsapp(text, L).chunks).toEqual(expected);
    });
  }
  it("honours a custom chunk target, overhead reserved", () => {
    const text = inputs[4] as string;
    const expected = balanceFences(
      chunkForWhatsapp(markdownToWhatsApp(text), 300 - FENCE_OVERHEAD),
    );
    expect(renderForWhatsapp(text, { ...L, chunkTarget: 300 }).chunks).toEqual(expected);
  });
});

// Review round 1 found the leak assertions vacuous: every tested `leaked` was
// empty, so `return []` would have passed all of them. These inputs are ones the
// converter genuinely leaves for the detector to find, so the firing path is
// exercised for real.
describe("renderForWhatsapp — the check actually runs and actually warns", () => {
  // These are the only reachable non-empty cases, and BOTH are the converter
  // behaving correctly — see the note on renderForWhatsapp. They are used here
  // because they are the only way to exercise the firing path for real; an
  // implementation returning [] passes every other test in this file.
  it("flags a bare delimiter row the converter passes through (a FALSE POSITIVE, used as a probe)", () => {
    // Not a table to the parser (no header), so it is prose the author wrote and
    // is delivered verbatim. Flagging it is the accepted false-positive class.
    expect(renderForWhatsapp("|---|", L).leaked).toEqual(["|table|"]);
  });
  it("flags escaped markdown the author asked to show literally (also a FALSE POSITIVE)", () => {
    // `\*\*escaped\*\*` renders to `**escaped**`, which is what escaping REQUESTED —
    // WhatsApp has no `**` syntax, so it displays literally. Correct output.
    expect(renderForWhatsapp("\\*\\*escaped\\*\\*", L).leaked).toEqual(["**bold**"]);
  });
  it("emits the warning itself, with the caller's label and no message text", () => {
    const seen: string[] = [];
    renderForWhatsapp("|---|", { label: "voice=v-9", warn: (m) => seen.push(m) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("MARKDOWN LEAK");
    expect(seen[0]).toContain("|table|");
    expect(seen[0]).toContain("voice=v-9");
    expect(seen[0]).toContain("chars=5");
    // The whole privacy claim: the rendered text must not be in the log line.
    expect(seen[0]).not.toContain("|---|");
  });
  it("stays silent when nothing leaked", () => {
    const seen: string[] = [];
    renderForWhatsapp("## Summary\n\n**done**", { label: "thread=t", warn: (m) => seen.push(m) });
    expect(seen).toEqual([]);
  });
  it("still returns chunks when a leak is reported — reporting never blocks delivery", () => {
    expect(renderForWhatsapp("|---|", L).chunks).toEqual(["|---|"]);
  });
});

describe("renderForWhatsapp — derived from the RENDERED text, not the input", () => {
  it("does not flag a heading the converter successfully removed", () => {
    // residualMarkdown("## Summary") is ["#heading"]; on the rendered form it is
    // empty. Checking the input instead of the output would warn on every
    // correctly converted reply.
    expect(residualMarkdown("## Summary")).toEqual(["#heading"]);
    expect(renderForWhatsapp("## Summary", L).leaked).toEqual([]);
  });
  it("reports chars as the RENDERED length", () => {
    const text = "## Summary";
    expect(renderForWhatsapp(text, L).chars).toBe(markdownToWhatsApp(text).length);
  });
});

describe("renderForWhatsapp — degenerate chunk targets (round 2 depth)", () => {
  // A target at or below FENCE_OVERHEAD leaves a non-positive budget after the
  // reservation. Untested until review asked; pinned here so a chunker change
  // cannot start throwing or returning nothing on a misconfigured target.
  for (const target of [FENCE_OVERHEAD, FENCE_OVERHEAD - 1, 1, 0]) {
    it(`target=${target} matches the inline pipeline and does not throw`, () => {
      const text = "a reply with **bold**, a `span` and several sentences of prose to split.";
      const expected = balanceFences(
        chunkForWhatsapp(markdownToWhatsApp(text), target - FENCE_OVERHEAD),
      );
      expect(renderForWhatsapp(text, { ...L, chunkTarget: target }).chunks).toEqual(expected);
    });
  }
});
