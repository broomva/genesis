import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { markdownToWhatsApp } from "./whatsapp-format";

/** The skill seeded into every tenant workspace. Its prose IS the product: a
 *  false line here is a false belief installed into every tenant agent, which
 *  then acts on it. */
const SKILL = resolve(import.meta.dir, "../../../tenant-skills/whatsapp-channel/SKILL.md");
const doc = readFileSync(SKILL, "utf8");

/** Rows PARSED OUT OF THE DOCUMENT, keyed by the example in the left column.
 *
 *  WHY IT READS THE DOC. The previous version asserted the renderer against a
 *  list hard-coded HERE and never opened SKILL.md — so the table could have said
 *  anything and every test still passed. Review called that illusory and was
 *  right: it was the same circularity as checking the rows I had chosen to
 *  write, moved up one level. The doc is the artifact under test, so the doc is
 *  what must be read. */
interface DocRow {
  readonly input: string;
  readonly claim: string;
  readonly line: string;
}

function parseConversionRows(md: string): DocRow[] {
  const rows: DocRow[] = [];
  for (const line of md.split("\n")) {
    const m = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/.exec(line.trim());
    if (!m) continue;
    const [, left, right] = m;
    if (!left || !right) continue;
    if (/^-+$/.test(left) || left === "You write") continue;
    // Only rows whose left cell is a single backticked example are executable
    // claims; prose rows ("a GFM table") are checked by the table tests below.
    const code = /^`([^`]+)`$/.exec(left);
    if (!code?.[1]) continue;
    rows.push({ input: code[1], claim: right, line });
  }
  return rows;
}

const DOC_ROWS = parseConversionRows(doc);

/** What the right-hand cell asserts, for rows whose claim is a literal output. */
function expectedOutput(claim: string): string | undefined {
  const code = /^`([^`]+)`$/.exec(claim.trim());
  return code?.[1];
}

describe("every executable row of the doc's table is true of the renderer", () => {
  test("the table was actually found and parsed", () => {
    // A parser that silently matches nothing would make every test below vacuous.
    expect(DOC_ROWS.length).toBeGreaterThanOrEqual(8);
  });

  for (const row of DOC_ROWS) {
    const expected = expectedOutput(row.claim);
    if (expected === undefined) continue; // prose claim, covered elsewhere
    test(`doc says ${JSON.stringify(row.input)} -> ${JSON.stringify(expected)}`, () => {
      expect(markdownToWhatsApp(row.input)).toBe(expected);
    });
  }

  test("the fence row states the dropped language, and the renderer drops it", () => {
    // Not an executable row: its left cell uses four backticks to quote a
    // three-backtick fence, so the parser correctly skips it. Asserted against
    // the raw document line instead.
    const fenceRow = doc.split("\n").find((l) => l.includes("fence") && l.startsWith("|"));
    expect(fenceRow).toBeDefined();
    expect(fenceRow).toMatch(/language identifier is dropped/i);
    expect(markdownToWhatsApp("```ts\nx\n```")).toBe("```\nx\n```");
  });
});

describe("the skill's table description matches the real renderer", () => {
  test("an empty cell is omitted entirely", () => {
    expect(markdownToWhatsApp("| a | b |\n|---|---|\n| 1 |  |")).toBe("• *1*");
    expect(doc).toMatch(/empty cell is omitted/i);
  });

  test("a header-only table becomes plain bullets", () => {
    expect(markdownToWhatsApp("| a | b |\n|---|---|")).toBe("• a\n• b");
    expect(doc).toMatch(/header-only table/i);
  });

  test("the first column's header is NOT shown", () => {
    const out = markdownToWhatsApp("| Name | Note |\n|---|---|\n| x | y |");
    expect(out).toContain("*x*");
    expect(out).toContain("Note: y");
    expect(out).not.toContain("Name"); // deliberately omitted
    expect(doc).toMatch(/first column/i);
  });
});

describe("the skill's transport numbers match the code", () => {
  test("it states the REAL 4096 cap, not a rounded one", async () => {
    // It previously said "4000-character bubble", which reads as the limit and
    // is not it.
    const src = readFileSync(resolve(import.meta.dir, "handler.ts"), "utf8");
    const cap = /WHATSAPP_TEXT_LIMIT = (\d+)/.exec(src)?.[1];
    const target = /CHUNK_TARGET = (\d+)/.exec(src)?.[1];
    expect(cap).toBe("4096");
    expect(doc).toContain(cap ?? "__");
    expect(doc).toContain(target ?? "__");
  });

  test("it names the re-engagement error code the handler actually matches", () => {
    const src = readFileSync(resolve(import.meta.dir, "handler.ts"), "utf8");
    const code = /REENGAGEMENT_ERROR_CODE = (\d+)/.exec(src)?.[1];
    expect(code).toBe("131047");
    expect(doc).toContain(code ?? "__");
  });
});

describe("the no-attachments claim is coupled to the actual interface", () => {
  test("ANY new member of PostableThread fails this test", () => {
    // Two earlier versions of this were too weak, each in a different way.
    // First it grepped the DOC for the phrase "cannot send files", which adding
    // an attachment API would not have broken. Then it blocklisted member names
    // matching /files|attachment|media|upload/ - which review correctly noted
    // misses `postFile()` and `sendDocument()`.
    //
    // An ALLOWLIST is the only shape that holds: pin the exact members the
    // interface has today, so ANY addition - whatever it is called - turns this
    // red and forces whoever adds a delivery path to update the skill in the
    // same change.
    const src = readFileSync(resolve(import.meta.dir, "handler.ts"), "utf8");
    const iface = /export interface PostableThread \{[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    expect(iface).not.toBe("");

    const members = [...iface.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?(:]/gm)]
      .map((m) => m[1])
      .filter((n): n is string => Boolean(n) && n !== "export" && n !== "interface");

    expect([...new Set(members)].sort()).toEqual(["id", "post", "startTyping"]);
    // Only while that holds may the seeded skill assert it.
    expect(doc).toMatch(/cannot send files/i);
  });
});

describe("the degenerate table cases the doc now documents", () => {
  test("an empty FIRST cell leaves a bare bullet", () => {
    // The prose said "an empty cell is omitted entirely", which is true of
    // every cell EXCEPT the lead: there the row loses its name and the bullet
    // stands alone. An unconditional claim that is false in one case is the
    // same drift this whole file exists to prevent.
    expect(markdownToWhatsApp("| a | b |\n|---|---|\n|  | 2 |")).toBe("•\n  b: 2");
    expect(doc).toMatch(/empty FIRST\s+cell/i);
  });

  test("an empty header labels its value by position", () => {
    expect(markdownToWhatsApp("| a |  |\n|---|---|\n| 1 | 2 |")).toBe("• *1*\n  2: 2");
    expect(doc).toMatch(/empty header/i);
  });
});
