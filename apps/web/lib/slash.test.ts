import { describe, expect, test } from "bun:test";
import { parseSlash, slashHelpText } from "./slash";

describe("parseSlash", () => {
  test("matches registered commands + aliases case-insensitively", () => {
    expect(parseSlash("/new")).toBe("new");
    expect(parseSlash("/reset")).toBe("reset");
    expect(parseSlash("/clear")).toBe("reset"); // alias
    expect(parseSlash("/HELP")).toBe("help");
    expect(parseSlash("/?")).toBe("help");
  });

  test("ignores trailing args (matches the first token)", () => {
    expect(parseSlash("/reset please")).toBe("reset");
    expect(parseSlash("  /new  ")).toBe("new");
  });

  test("returns null for normal messages + unknown slashes", () => {
    expect(parseSlash("hello")).toBeNull();
    expect(parseSlash("what is /reset?")).toBeNull(); // not leading
    expect(parseSlash("/bogus")).toBeNull();
    expect(parseSlash("")).toBeNull();
  });

  test("help text lists every command", () => {
    const help = slashHelpText();
    expect(help).toContain("/new");
    expect(help).toContain("/reset");
    expect(help).toContain("/help");
  });
});
