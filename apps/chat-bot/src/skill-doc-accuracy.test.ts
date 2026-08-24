import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { markdownToWhatsApp } from "./whatsapp-format";

/** The skill seeded into every tenant workspace. Its prose IS the product: a
 *  false line here is a false belief installed into every tenant agent, which
 *  then acts on it. */
const SKILL = resolve(import.meta.dir, "../../../tenant-skills/whatsapp-channel/SKILL.md");
const doc = readFileSync(SKILL, "utf8");

/** Rows of the "You write | They receive" table, as CLAIMS to be checked
 *  against the real renderer.
 *
 *  WHY THIS EXISTS. Cross-model review found the table had drifted — it claimed
 *  fences were "preserved" while the language identifier is silently dropped,
 *  and described a table shape that is not universal. My own verification had
 *  missed it because I checked the rows I had chosen to write, which cannot
 *  find what I omitted. Asserting the DOC against the CODE is the only version
 *  of that check which can fail for the right reason. */
const CLAIMS: ReadonlyArray<readonly [input: string, expected: string, note: string]> = [
  ["**bold**", "*bold*", "bold"],
  ["*italic*", "_italic_", "italic"],
  ["***both***", "_*both*_", "nested emphasis"],
  ["~~strike~~", "~strike~", "strikethrough"],
  ["`code`", "`code`", "inline code unchanged"],
  ["# Heading", "*Heading*", "heading becomes a bold line"],
  ["###### Heading", "*Heading*", "every heading level, same result"],
  ["- item", "• item", "bullet"],
  ["> quote", "> quote", "blockquote unchanged"],
  ["[label](https://x.dev)", "label (https://x.dev)", "link keeps label and url"],
  ["[https://x.dev](https://x.dev)", "https://x.dev", "label == url collapses"],
  ["![alt](https://img.dev/a.png)", "https://img.dev/a.png", "image loses alt text"],
];

describe("the skill's conversion table matches the real renderer", () => {
  for (const [input, expected, note] of CLAIMS) {
    test(`${note}: ${JSON.stringify(input)}`, () => {
      expect(markdownToWhatsApp(input)).toBe(expected);
    });
  }

  test("the fence LANGUAGE is dropped, and the skill says so", () => {
    // The specific drift review caught: "fences preserved" was true of the
    // fence and false of its language.
    expect(markdownToWhatsApp("```ts\nx\n```")).toBe("```\nx\n```");
    expect(doc).toMatch(/language identifier is dropped/i);
  });

  test("ordered lists keep numbering, and the skill says so", () => {
    expect(markdownToWhatsApp("5. five")).toContain("5. five");
    expect(doc).toMatch(/numbering kept/i);
  });

  test("a task-list checkbox stays literal, and the skill says so", () => {
    expect(markdownToWhatsApp("- [x] done")).toBe("• [x] done");
    expect(doc).toMatch(/checkbox stays literal/i);
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
  test("if PostableThread gains a file path, this test fails", () => {
    // The previous coupling was a grep for the phrase "cannot send files",
    // which review correctly called bypassable: adding an attachment API would
    // not have made it fail. This reads the INTERFACE instead, so the claim and
    // the code cannot diverge silently.
    const src = readFileSync(resolve(import.meta.dir, "handler.ts"), "utf8");
    const iface = /export interface PostableThread \{[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    expect(iface).not.toBe("");
    const hasFileChannel = /files|attachment|media|upload/i.test(iface);
    expect(hasFileChannel).toBe(false);
    // Only while the above holds may the skill assert it.
    expect(doc).toMatch(/cannot send files/i);
  });
});
