import { describe, expect, test } from "bun:test";
import { balanceFences, endsInsideFence, markdownToWhatsApp as fmt } from "./whatsapp-format";

/** The message that actually failed on a real phone (BRO-2267), abridged.
 *  A fixture taken from production output rather than invented, so the test
 *  fails for the same reason the user's screenshot did. */
const REAL_FAILURE = `Hi! Here's where things landed — I **did successfully run Parallax**. Quick recap:

## ✅ What ran
| What | Command | Result |
|---|---|---|
| Setup | Installed Bun 1.4.0 locally + \`bun install\` | ✅ |
| **Main demo** | \`bun run src/demo.ts\` | ✅ Full RUN→OBSERVE cycle |

## The interesting bits
- caught an ungoverned sales agent overselling stock (\`panela: -1\`)
- proved replay: same seed → \`435b1748…\` **IDENTICAL**, seed+1 → **DIVERGED (correct)**`;

describe("the real screenshot no longer renders as raw markdown", () => {
  const out = fmt(REAL_FAILURE);

  test("no heading hashes survive", () => {
    expect(out).not.toMatch(/^#{1,6}\s/m);
    expect(out).toContain("*✅ What ran*"); // hierarchy kept as emphasis
  });

  test("no raw table pipes or alignment rows survive", () => {
    expect(out).not.toContain("|---|");
    expect(out).not.toMatch(/^\|.*\|$/m);
  });

  test("table DATA survives — the cells are still there and still associated", () => {
    // The failure mode to avoid is the adapter's: cells fused into "ab12".
    expect(out).toContain("Setup");
    expect(out).toContain("Installed Bun 1.4.0");
    expect(out).toContain("Command:"); // labelled by its header
    expect(out).toContain("Result:");
    expect(out).not.toContain("SetupInstalled"); // never concatenated
  });

  test("no stray double asterisks anywhere", () => {
    expect(out).not.toContain("**");
  });

  test("bold became WhatsApp bold", () => {
    expect(out).toContain("*did successfully run Parallax*");
  });

  test("inline code is untouched", () => {
    expect(out).toContain("`bun install`");
    expect(out).toContain("`panela: -1`");
  });
});

describe("inline conversion", () => {
  test("**bold** -> *bold*", () => {
    expect(fmt("a **b** c")).toBe("a *b* c");
    expect(fmt("a __b__ c")).toBe("a *b* c");
  });

  test("markdown *italic* -> _italic_, NOT bold", () => {
    // The collision that produced the strays: markdown `*` is italic, WhatsApp
    // `*` is bold. Converting naively turns every italic into a bold.
    expect(fmt("a *b* c")).toBe("a _b_ c");
  });

  test("bold and italic together keep their distinct meanings", () => {
    expect(fmt("**bold** and *italic*")).toBe("*bold* and _italic_");
  });

  test("~~strike~~ -> ~strike~", () => {
    expect(fmt("a ~~b~~ c")).toBe("a ~b~ c");
  });

  test("[label](url) -> label (url)", () => {
    expect(fmt("see [docs](https://x.dev)")).toBe("see docs (https://x.dev)");
  });

  test("a bare asterisk is left alone", () => {
    expect(fmt("2 * 3 = 6")).toBe("2 * 3 = 6");
  });
});

describe("blocks", () => {
  test("every heading level becomes one bold line", () => {
    for (const h of ["#", "##", "###", "####", "#####", "######"]) {
      expect(fmt(`${h} Title`)).toBe("*Title*");
    }
  });

  test("a heading containing bold does not nest emphasis", () => {
    // `*a *b* c*` renders as broken runs on WhatsApp.
    expect(fmt("## A **B** C")).toBe("*A B C*");
  });

  test("bullets are normalised", () => {
    // markdown treats a marker change as a NEW list, so mixed markers are
    // three lists; that spacing is correct, not a bug.
    expect(fmt("- one\n- two\n- three")).toBe("• one\n• two\n• three");
  });

  test("a table without an alignment row is left ALONE, not mangled", () => {
    // Lossless-by-default: an unrecognised construct passes through, because
    // showing it plainly beats destroying it.
    const t = "| a | b |\n| 1 | 2 |";
    expect(fmt(t)).toContain("| a | b |");
  });

  test("a single-row table (header only) still shows its cells", () => {
    expect(fmt("| a | b |\n|---|---|")).toBe("• a\n• b");
  });

  test("empty cells are dropped rather than shown as blank labels", () => {
    const out = fmt("| Name | Note |\n|---|---|\n| x |  |");
    expect(out).toContain("*x*");
    expect(out).not.toContain("Note:");
  });
});

describe("code blocks are protected from every other transform", () => {
  test("markdown-looking characters inside a fence are preserved exactly", () => {
    const md = "text\n\n```\n## not a heading\n| a | b |\n|---|---|\n**not bold**\n```\n\nafter";
    const out = fmt(md);
    expect(out).toContain("## not a heading");
    expect(out).toContain("| a | b |");
    expect(out).toContain("**not bold**");
    expect(out).toContain("|---|");
  });

  test("prose around a fence is still converted", () => {
    const out = fmt("## Title\n\n```\nraw **x**\n```\n\n**bold**");
    expect(out).toContain("*Title*");
    expect(out).toContain("raw **x**"); // inside fence: untouched
    expect(out).toContain("*bold*");
  });

  test("two fences do not swap contents", () => {
    const out = fmt("```\nFIRST\n```\n\nmid\n\n```\nSECOND\n```");
    expect(out.indexOf("FIRST")).toBeLessThan(out.indexOf("SECOND"));
  });
});

describe("totality", () => {
  test("empty and whitespace input are safe", () => {
    expect(fmt("")).toBe("");
    expect(fmt("   ")).toBe("");
  });

  test("plain prose is unchanged", () => {
    expect(fmt("just a normal sentence.")).toBe("just a normal sentence.");
  });

  test("output never contains the internal placeholder", () => {
    // A leaked sentinel would be visible garbage on the user's phone.
    const out = fmt(`${REAL_FAILURE}\n\n\`\`\`\ncode\n\`\`\``);
    expect(out).not.toMatch(/[\uE000-\uE00F]/); // AST renderer has no sentinels at all
    expect(out).not.toMatch(/CODE\d/);
  });
});

describe("P20 blockers — what a regex pipeline could not see", () => {
  test("BLOCKER: inline code is never reinterpreted as markup", () => {
    // The regex version rewrote `**literal**` to `*literal*`, corrupting the
    // code it was quoting.
    expect(fmt("use `**literal**` here")).toBe("use `**literal**` here");
    expect(fmt("run `a_b_c` now")).toBe("run `a_b_c` now");
    expect(fmt("`# not a heading`")).toBe("`# not a heading`");
  });

  test("BLOCKER: tilde fences are fences", () => {
    expect(fmt("~~~\n**raw**\n~~~")).toContain("**raw**");
  });

  test("BLOCKER: a longer backtick run is a fence", () => {
    expect(fmt("````\ninner ``` still code\n````")).toContain("inner ``` still code");
  });

  test("BLOCKER: an unclosed fence does not corrupt what follows", () => {
    expect(fmt("text\n\n```\n**raw**")).toContain("**raw**");
  });

  test("MAJOR: ***both*** nests instead of breaking", () => {
    // The regex version produced `*_x*_` — overlapping, unrenderable runs.
    expect(fmt("***x***")).toBe("_*x*_");
  });

  test("MAJOR: intraword underscores are not emphasis", () => {
    expect(fmt("foo_bar_baz")).toBe("foo_bar_baz");
    expect(fmt("snake_case_name")).toBe("snake_case_name");
  });

  test("MAJOR: a ragged row keeps its extra cells", () => {
    const out = fmt("| a | b |\n|---|---|\n| 1 | 2 | EXTRA |");
    expect(out).toContain("EXTRA");
  });

  test("ordered lists keep their numbers", () => {
    const out = fmt("1. first\n2. second");
    expect(out).toContain("1. first");
    expect(out).toContain("2. second");
  });

  test("blockquotes use WhatsApp's own > syntax", () => {
    expect(fmt("> quoted")).toBe("> quoted");
  });

  test("a table cell containing bold does not double-wrap", () => {
    const out = fmt("| a | b |\n|---|---|\n| **x** | 2 |");
    expect(out).not.toContain("**");
    expect(out).toContain("*x*");
  });
});

describe("BLOCKER: chunk boundaries must not break fenced code", () => {
  test("endsInsideFence detects an unmatched delimiter", () => {
    expect(endsInsideFence("```\ncode")).toBe(true);
    expect(endsInsideFence("```\ncode\n```")).toBe(false);
    expect(endsInsideFence("no fence at all")).toBe(false);
  });

  test("a fence split across chunks is closed and reopened", () => {
    const balanced = balanceFences(["intro\n```\npart one", "part two\n```"]);
    for (const c of balanced) expect(endsInsideFence(c)).toBe(false);
    expect(balanced[1]).toContain("part two");
    expect(balanced[1]?.startsWith("```")).toBe(true); // monospace resumes
  });

  test("chunks with no fences are untouched", () => {
    const input = ["plain one", "plain two"];
    expect(balanceFences(input)).toEqual(input);
  });

  test("a three-way split leaves every chunk balanced", () => {
    const balanced = balanceFences(["```\na", "b", "c\n```"]);
    for (const c of balanced) expect(endsInsideFence(c)).toBe(false);
    expect(balanced.join("\n")).toContain("b");
  });
});
