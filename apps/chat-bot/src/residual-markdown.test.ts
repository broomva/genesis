import { describe, expect, it } from "bun:test";
import { markdownToWhatsApp, residualMarkdown } from "./whatsapp-format";

// The check exists because BRO-2267 shipped raw markdown to phones and only a
// human reading delivered messages noticed. So these tests assert BOTH halves:
// it catches the leak, and it stays silent on output that is already correct.
// A warning that fires on legitimate content would be turned off within a week.

describe("residualMarkdown — catches the BRO-2267 symptoms", () => {
  it("flags **bold** that survived conversion", () => {
    expect(residualMarkdown("In one line: the **dynamic** side reads your context")).toEqual([
      "**bold**",
    ]);
  });
  it("flags an ATX heading", () => {
    expect(residualMarkdown("## Summary\nthe run finished")).toEqual(["#heading"]);
  });
  it("flags a table delimiter row", () => {
    expect(residualMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")).toEqual(["|table|"]);
  });
  it("flags link syntax", () => {
    expect(residualMarkdown("see [the receipt](https://example.com/r) for detail")).toEqual([
      "[link](url)",
    ]);
  });
  it("reports every distinct leak, not just the first", () => {
    expect(residualMarkdown("## H\n**b** and [l](https://x.y)").sort()).toEqual(
      ["#heading", "**bold**", "[link](url)"].sort(),
    );
  });
});

describe("residualMarkdown — does NOT fire on correct output", () => {
  it("is silent on WhatsApp's own single-asterisk bold", () => {
    expect(residualMarkdown("• *Finish the flow* — invoke `/parallax` now")).toEqual([]);
  });
  it("is silent on a real converted reply", () => {
    const rendered = markdownToWhatsApp(
      "## Status\n\n**Done**: repo cloned\n\n- tests pass\n- [docs](https://example.com)\n",
    );
    expect(residualMarkdown(rendered)).toEqual([]);
  });
  it("is silent on empty text", () => {
    expect(residualMarkdown("")).toEqual([]);
  });
});

describe("residualMarkdown — fenced code is exempt (the false-positive killer)", () => {
  // Every one of these is CORRECT output: the converter leaves fenced regions
  // verbatim on purpose. Scanning them would fire constantly on ordinary code.
  it("ignores **kwargs in a Python fence", () => {
    expect(residualMarkdown("here:\n```\ndef f(*args, **kwargs):\n    pass\n```\n")).toEqual([]);
  });
  it("ignores a shell comment that looks like a heading", () => {
    expect(residualMarkdown("```\n# install deps\nbun install\n```")).toEqual([]);
  });
  it("ignores an ASCII table inside a fence", () => {
    expect(residualMarkdown("```\n| col |\n|-----|\n| val |\n```")).toEqual([]);
  });
  it("treats an UNTERMINATED fence as code all the way down", () => {
    expect(residualMarkdown("output:\n```\n**not bold**\n## not a heading")).toEqual([]);
  });
  it("still catches a leak OUTSIDE a fence when a fence is also present", () => {
    expect(residualMarkdown("**leaked**\n```\n**kwargs\n```\n")).toEqual(["**bold**"]);
  });
});

// ─── Round-1 review findings ────────────────────────────────────────────────
// Every case below was named by cross-model review of the first version. The
// false positives are the important half: the first version warned on ordinary
// replies containing inline code, which is how a check gets muted and stops
// being worth having.

describe("residualMarkdown — inline code is exempt (round 1 false positives)", () => {
  it("does not warn on `f(**kwargs)` in an inline span", () => {
    expect(residualMarkdown("call `f(**kwargs)` to forward them")).toEqual([]);
  });
  it("does not warn on a glob in an inline span", () => {
    expect(residualMarkdown("ignore `**/*.test.ts` for now")).toEqual([]);
  });
  it("does not warn on link syntax shown as an inline example", () => {
    expect(residualMarkdown("write it as `[label](/route)` in the source")).toEqual([]);
  });
  it("does not warn on exponentiation in plain prose (single marker, no pair)", () => {
    expect(residualMarkdown("the runtime is 2**n in the worst case")).toEqual([]);
  });
  it("does not warn on a lone **kwargs in prose", () => {
    expect(residualMarkdown("pass **kwargs through to the callee")).toEqual([]);
  });
});

describe("residualMarkdown — other fence forms are exempt (round 1)", () => {
  it("ignores a tilde fence", () => {
    expect(residualMarkdown("~~~python\ndef f(**kwargs): ...\n~~~")).toEqual([]);
  });
  it("ignores a fence carrying a language tag", () => {
    expect(residualMarkdown("```ts\nconst a = b ** c;\n// ## not a heading\n```")).toEqual([]);
  });
  it("does not fabricate a heading when a fence is joined away", () => {
    // Joining segments with "\n" turned `text ```x``` ## literal` into a false
    // line-start heading. Fences now collapse to a space.
    expect(residualMarkdown("prefix ```x``` ## literal")).toEqual([]);
  });
});

describe("residualMarkdown — leaks after a closed fence (round 1 false negative)", () => {
  // No round-1 test put a leak AFTER a closed fence, so a mutation that discarded
  // everything from the first fence onward would have SURVIVED.
  it("catches bold after a closed fence", () => {
    expect(residualMarkdown("```\ncode\n```\n**leaked**")).toEqual(["**bold**"]);
  });
  it("catches a heading after a closed fence", () => {
    expect(residualMarkdown("```\ncode\n```\n## leaked")).toEqual(["#heading"]);
  });
  it("catches a table rule after a closed fence", () => {
    expect(residualMarkdown("```\ncode\n```\n| a | b |\n|---|---|")).toEqual(["|table|"]);
  });
});

describe("residualMarkdown — the table rule does not span lines (round 1)", () => {
  it("does not treat a pipe, newline, dash, newline, pipe as a delimiter row", () => {
    expect(residualMarkdown("|\n-\n|")).toEqual([]);
  });
});

describe("residualMarkdown — two independent ** operators are not a bold pair (round 2)", () => {
  // Review round 2's blocker: correct technical prose in which two exponent
  // operators on one line paired up. Real emphasis opens at a word boundary.
  it("does not warn on two exponents on one line", () => {
    expect(residualMarkdown("The branches take 2**n and 3**m steps.")).toEqual([]);
  });
  it("does not warn on a**b + c**d", () => {
    expect(residualMarkdown("cost is a**b + c**d overall")).toEqual([]);
  });
  it("still catches bold opening after whitespace", () => {
    expect(residualMarkdown("the **dynamic** side reads context")).toEqual(["**bold**"]);
  });
  it("still catches bold opening at line start", () => {
    expect(residualMarkdown("**Done**: repo cloned")).toEqual(["**bold**"]);
  });
  it("still catches bold opening after opening punctuation", () => {
    expect(residualMarkdown("see (**note**) below")).toEqual(["**bold**"]);
  });
  it("does not warn when the closer follows whitespace", () => {
    expect(residualMarkdown("a ** b ** c")).toEqual([]);
  });
});

describe("residualMarkdown — a boundary opener cannot pair with a mid-token closer (round 3)", () => {
  // Review round 3: the `(` let `(**kwargs` open at a boundary and `2**n` close it.
  it("does not warn on kwargs and an exponent in one sentence", () => {
    expect(residualMarkdown("The expression f(**kwargs) costs 2**n steps.")).toEqual([]);
  });
  it("does not warn when a bracketed operator meets a later exponent", () => {
    expect(residualMarkdown("call g(**opts) with 3**k retries")).toEqual([]);
  });
  it("still catches bold ending at punctuation", () => {
    expect(residualMarkdown("**Done**: repo cloned")).toEqual(["**bold**"]);
  });
  it("still catches bold ending at end of line", () => {
    expect(residualMarkdown("status is **green**")).toEqual(["**bold**"]);
  });
});

// ─── The production boundary ────────────────────────────────────────────────
// Everything above tests residualMarkdown in isolation. In production it is
// never called on a raw reply — it is called on markdownToWhatsApp(reply). That
// distinction turned out to matter more than three rounds of regex tuning:
// every "false positive" review raised (`2**n and 3**m`, `f(**kwargs) ... 2**-1`)
// is UNREACHABLE there, because the converter has already consumed those markers
// by the time the check runs. These tests pin the real contract.

describe("residualMarkdown at the production boundary — silent when the converter works", () => {
  const correct = [
    "the **dynamic** side reads context",
    "## Summary\n\nbody text",
    "| a | b |\n|---|---|\n| 1 | 2 |",
    "see [docs](https://example.com/z)",
    "The branches take 2**n and 3**m steps.",
    "Call f(**kwargs) and calculate 2**-1.",
    "f(**kwargs) then 2**(n + 1) overall",
    "ignore **/*.test.ts for now",
    "use `f(**kwargs)` and `**/*.test.ts` here",
    "```python\ndef f(*a, **kw): pass\n```",
  ];
  for (const reply of correct) {
    it(`stays silent on: ${JSON.stringify(reply.slice(0, 38))}`, () => {
      expect(residualMarkdown(markdownToWhatsApp(reply))).toEqual([]);
    });
  }
});

describe("residualMarkdown at the production boundary — fires when the converter is BYPASSED", () => {
  // This is how BRO-2267 actually failed: the reply reached the transport
  // without conversion. Skipping markdownToWhatsApp is the regression the check
  // exists to catch, so it is the scenario worth asserting.
  it("catches unconverted bold", () => {
    expect(residualMarkdown("the **dynamic** side reads context")).toEqual(["**bold**"]);
  });
  it("catches an unconverted heading", () => {
    expect(residualMarkdown("## Summary\n\nbody text")).toEqual(["#heading"]);
  });
  it("catches an unconverted table rule", () => {
    expect(residualMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")).toEqual(["|table|"]);
  });
  it("catches an unconverted link", () => {
    expect(residualMarkdown("see [docs](https://example.com/z)")).toEqual(["[link](url)"]);
  });
});
