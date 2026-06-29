import { describe, expect, test } from "bun:test";
import { filesChangedFromParts } from "./files-changed";

type Parts = Parameters<typeof filesChangedFromParts>[0];
const tool = (toolName: string, file_path?: string, state = "output-available") => ({
  type: "dynamic-tool",
  toolName,
  toolCallId: "x",
  state,
  input: file_path ? { file_path } : {},
  output: "",
});

describe("filesChangedFromParts (BRO-1612)", () => {
  test("collects unique write-class file paths in first-seen order", () => {
    const parts = [
      { type: "text", text: "x" },
      tool("Bash"),
      tool("Edit", "/a.ts"),
      tool("Read", "/b.ts"), // read is not a write tool
      tool("Write", "/c.ts"),
      tool("Edit", "/a.ts"), // dup → dropped
      tool("MultiEdit", "/d.ts"),
    ] as unknown as Parts;
    expect(filesChangedFromParts(parts)).toEqual(["/a.ts", "/c.ts", "/d.ts"]);
  });

  test("ignores non-write / pathless parts", () => {
    expect(filesChangedFromParts([tool("Read", "/x")] as unknown as Parts)).toEqual([]);
    expect(filesChangedFromParts([tool("Bash")] as unknown as Parts)).toEqual([]);
    expect(filesChangedFromParts([{ type: "text", text: "x" }] as unknown as Parts)).toEqual([]);
    expect(filesChangedFromParts([tool("Edit")] as unknown as Parts)).toEqual([]); // no file_path
  });

  test("excludes failed + in-flight writes (only succeeded count, BRO-1612 P20)", () => {
    const parts = [
      tool("Edit", "/ok.ts", "output-available"),
      tool("Edit", "/failed.ts", "output-error"), // failed → not changed
      tool("Write", "/inflight.ts", "input-available"), // not yet run
    ] as unknown as Parts;
    expect(filesChangedFromParts(parts)).toEqual(["/ok.ts"]);
  });
});
