import { describe, expect, test } from "bun:test";
import {
  type DirListing,
  type FileContent,
  classifyFile,
  normalizeFile,
  normalizeListing,
  parseFrontmatter,
  rawFileUrl,
  splitFrontmatter,
} from "./files";

describe("normalizeListing (BRO-1666)", () => {
  test("passes clean entries through, preserving path + sizes", () => {
    const out = normalizeListing({
      path: "src",
      entries: [
        { name: "lib", type: "dir" },
        { name: "index.ts", type: "file", size: 42 },
      ],
    });
    expect(out).toEqual({
      path: "src",
      entries: [
        { name: "lib", type: "dir" },
        { name: "index.ts", type: "file", size: 42 },
      ],
      truncated: false,
    } satisfies DirListing);
  });

  test("passes the truncated flag through when the server sets it", () => {
    const out = normalizeListing({
      path: "",
      entries: [{ name: "a", type: "file" }],
      truncated: true,
    });
    expect(out.truncated).toBe(true);
  });

  test("drops malformed entries (bad/empty name, bad type) without crashing", () => {
    const out = normalizeListing({
      path: "",
      entries: [
        { name: "", type: "file" }, // empty name
        { name: "ok", type: "dir" },
        { name: "weird", type: "socket" }, // bad type
        { type: "file" }, // no name
        null,
        "nope",
      ],
    });
    expect(out.entries).toEqual([{ name: "ok", type: "dir" }]);
  });

  test("tolerates a missing/empty body → empty listing at root", () => {
    expect(normalizeListing(undefined)).toEqual({ path: "", entries: [], truncated: false });
    expect(normalizeListing({})).toEqual({ path: "", entries: [], truncated: false });
    expect(normalizeListing({ entries: "not-an-array" })).toEqual({
      path: "",
      entries: [],
      truncated: false,
    });
  });

  test("drops a non-numeric size rather than forwarding it", () => {
    const out = normalizeListing({ path: "", entries: [{ name: "f", type: "file", size: "big" }] });
    expect(out.entries[0]).toEqual({ name: "f", type: "file" });
  });
});

describe("normalizeFile (BRO-1666)", () => {
  test("passes a clean file body through", () => {
    const out = normalizeFile({
      path: "a.txt",
      content: "hello",
      truncated: false,
      binary: false,
      size: 5,
    });
    expect(out).toEqual({
      path: "a.txt",
      content: "hello",
      truncated: false,
      binary: false,
      size: 5,
    } satisfies FileContent);
  });

  test("coerces missing/garbage fields to safe defaults", () => {
    const out = normalizeFile({ path: 3, content: null, truncated: "yes", size: "x" });
    expect(out).toEqual({ path: "", content: "", truncated: false, binary: false, size: 0 });
  });

  test("honors truthy binary/truncated flags", () => {
    const out = normalizeFile({ path: "bin", content: "", truncated: true, binary: true, size: 9 });
    expect(out).toMatchObject({ binary: true, truncated: true, size: 9 });
  });
});

describe("classifyFile (BRO-1667)", () => {
  test("classifies by extension (case-insensitive, path-aware)", () => {
    expect(classifyFile("README.md")).toEqual({ kind: "markdown" });
    expect(classifyFile("docs/GUIDE.MARKDOWN")).toEqual({ kind: "markdown" });
    expect(classifyFile("a/b/logo.PNG")).toEqual({ kind: "image" });
    expect(classifyFile("icon.svg")).toEqual({ kind: "image" });
    expect(classifyFile("page.html")).toEqual({ kind: "html" });
    expect(classifyFile("report.pdf")).toEqual({ kind: "pdf" });
    expect(classifyFile("src/server.ts")).toEqual({ kind: "code", lang: "typescript" });
    expect(classifyFile("main.rs")).toEqual({ kind: "code", lang: "rust" });
    expect(classifyFile("data.yaml")).toEqual({ kind: "code", lang: "yaml" });
  });
  test("recognizes extensionless known names + defaults to text", () => {
    expect(classifyFile("Dockerfile")).toEqual({ kind: "code", lang: "dockerfile" });
    expect(classifyFile("Makefile")).toEqual({ kind: "code", lang: "makefile" });
    expect(classifyFile("LICENSE")).toEqual({ kind: "text" });
    expect(classifyFile("notes.log")).toEqual({ kind: "text" });
    expect(classifyFile("archive.zip")).toEqual({ kind: "text" }); // unknown ext → text (server flags binary)
  });
});

describe("splitFrontmatter (BRO-1667)", () => {
  test("separates a leading YAML block from the body", () => {
    const out = splitFrontmatter("---\ntitle: Hi\ntype: note\n---\n# Body\n\ntext");
    expect(out.frontmatter).toBe("title: Hi\ntype: note");
    expect(out.body).toBe("# Body\n\ntext");
  });
  test("handles CRLF + a frontmatter-only doc", () => {
    const out = splitFrontmatter("---\r\nk: v\r\n---\r\n");
    expect(out.frontmatter).toBe("k: v");
    expect(out.body).toBe("");
  });
  test("returns null frontmatter when there is no block", () => {
    expect(splitFrontmatter("# Just markdown")).toEqual({
      frontmatter: null,
      body: "# Just markdown",
    });
    // A `---` that isn't at the very start is not frontmatter.
    expect(splitFrontmatter("text\n---\nk: v\n---").frontmatter).toBeNull();
  });
});

describe("parseFrontmatter (BRO-1667)", () => {
  test("parses flat key: value rows", () => {
    expect(parseFrontmatter("title: Hello\ntype: note\nstatus: entity")).toEqual([
      { key: "title", value: "Hello" },
      { key: "type", value: "note" },
      { key: "status", value: "entity" },
    ]);
  });
  test("folds an indented list into the value", () => {
    const rows = parseFrontmatter("tags:\n  - security\n  - git\nrelated:\n  - x");
    expect(rows.find((r) => r.key === "tags")?.value).toBe("security, git");
    expect(rows.find((r) => r.key === "related")?.value).toBe("x");
  });
});

describe("rawFileUrl (BRO-1667)", () => {
  test("builds an encoded BFF raw URL", () => {
    expect(rawFileUrl("ws-broomva", "docs/a b.png")).toBe(
      "/api/workspaces/ws-broomva/file/raw?path=docs%2Fa%20b.png",
    );
  });
});
