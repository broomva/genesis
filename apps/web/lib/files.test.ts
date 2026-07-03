import { describe, expect, test } from "bun:test";
import { type DirListing, type FileContent, normalizeFile, normalizeListing } from "./files";

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
