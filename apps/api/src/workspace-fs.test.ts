import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_DIR_ENTRIES,
  MAX_FILE_BYTES,
  MAX_RAW_BYTES,
  WorkspaceFsError,
  contentTypeFor,
  listWorkspaceDir,
  readWorkspaceFile,
  readWorkspaceFileRaw,
  resolveInRoot,
} from "./workspace-fs";

const dirs: string[] = [];
/** A fresh temp workspace root. `outside` optionally creates a sibling dir OUTSIDE
 *  the root (for symlink-escape tests) and returns it too. */
function root(): string {
  const d = mkdtempSync(join(tmpdir(), "genesis-fs-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveInRoot — the path sandbox (BRO-1666)", () => {
  test("accepts the root itself (empty / undefined path)", () => {
    const dir = root();
    expect(resolveInRoot(dir, "").rel).toBe("");
    expect(resolveInRoot(dir, undefined).rel).toBe("");
    expect(resolveInRoot(dir, null).rel).toBe("");
  });

  test("accepts an in-root relative path + returns its canonical rel", () => {
    const dir = root();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "x");
    expect(resolveInRoot(dir, "src").rel).toBe("src");
    expect(resolveInRoot(dir, "src/a.ts").rel).toBe(join("src", "a.ts"));
    // `.`-segments normalize away but stay in-root.
    expect(resolveInRoot(dir, "./src/./a.ts").rel).toBe(join("src", "a.ts"));
  });

  test("rejects `..` traversal (lexical, before touching disk)", () => {
    const dir = root();
    expect(() => resolveInRoot(dir, "..")).toThrow(WorkspaceFsError);
    expect(() => resolveInRoot(dir, "../etc")).toThrow(/escapes/);
    expect(() => resolveInRoot(dir, "src/../../oops")).toThrow(/escapes/);
  });

  test("rejects an absolute path", () => {
    const dir = root();
    expect(() => resolveInRoot(dir, "/etc/passwd")).toThrow(/relative/);
  });

  test("rejects a NUL byte + a non-string", () => {
    const dir = root();
    expect(() => resolveInRoot(dir, "a\0b")).toThrow(/invalid/);
    expect(() => resolveInRoot(dir, 42 as unknown)).toThrow(/string/);
  });

  test("rejects a symlink escaping the root (HARD realpath boundary)", () => {
    const dir = root();
    const outside = root(); // a separate temp dir, not under `dir`
    writeFileSync(join(outside, "secret.txt"), "top secret");
    symlinkSync(outside, join(dir, "escape")); // dir/escape -> outside
    // Lexically dir/escape/secret.txt is "inside", but realpath lands outside → reject.
    expect(() => resolveInRoot(dir, "escape/secret.txt")).toThrow(/escapes/);
    expect(() => resolveInRoot(dir, "escape")).toThrow(/escapes/);
  });

  test("accepts a symlink that stays inside the root", () => {
    const dir = root();
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "f.txt"), "hi");
    symlinkSync(join(dir, "real"), join(dir, "link")); // in-root link
    expect(resolveInRoot(dir, "link/f.txt").rel).toBe(join("real", "f.txt"));
  });

  test("404s a missing path", () => {
    const dir = root();
    try {
      resolveInRoot(dir, "nope/missing.txt");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkspaceFsError);
      expect((e as WorkspaceFsError).status).toBe(404);
    }
  });

  test("500s an unavailable workspace root", () => {
    try {
      resolveInRoot(join(tmpdir(), "genesis-does-not-exist-xyz"), "");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkspaceFsError);
      expect((e as WorkspaceFsError).status).toBe(500);
    }
  });
});

describe("listWorkspaceDir (BRO-1666)", () => {
  test("lists dirs-first then files, alphabetical, with file sizes", () => {
    const dir = root();
    mkdirSync(join(dir, "zeta"));
    mkdirSync(join(dir, "alpha"));
    writeFileSync(join(dir, "readme.md"), "hello"); // 5 bytes
    writeFileSync(join(dir, ".env"), "SECRET=1"); // dotfiles ARE listed (screenshot parity)
    const { path, entries, truncated } = listWorkspaceDir(dir, "");
    expect(path).toBe("");
    expect(truncated).toBe(false);
    expect(entries.map((e) => e.name)).toEqual(["alpha", "zeta", ".env", "readme.md"]);
    expect(entries.filter((e) => e.type === "dir").map((e) => e.name)).toEqual(["alpha", "zeta"]);
    expect(entries.find((e) => e.name === "readme.md")?.size).toBe(5);
    expect(entries.find((e) => e.name === "alpha")?.size).toBeUndefined();
  });

  test("caps a huge directory + flags truncated, dirs still first (P20 F1)", () => {
    const dir = root();
    // 3 dirs + (cap) files → cap+3 total → over the cap.
    for (const name of ["d-a", "d-b", "d-c"]) mkdirSync(join(dir, name));
    for (let i = 0; i < MAX_DIR_ENTRIES; i++) {
      writeFileSync(join(dir, `f-${String(i).padStart(5, "0")}.txt`), "x");
    }
    const { entries, truncated } = listWorkspaceDir(dir, "");
    expect(truncated).toBe(true);
    expect(entries.length).toBe(MAX_DIR_ENTRIES);
    // The 3 dirs sort first (dirs-first is preserved under the cap).
    expect(entries.slice(0, 3).map((e) => e.name)).toEqual(["d-a", "d-b", "d-c"]);
    expect(entries.slice(0, 3).every((e) => e.type === "dir")).toBe(true);
  });

  test("lists a nested directory by relative path", () => {
    const dir = root();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "export {}");
    const { path, entries } = listWorkspaceDir(dir, "src");
    expect(path).toBe("src");
    expect(entries.map((e) => e.name)).toEqual(["index.ts"]);
  });

  test("hides a symlink that escapes the root", () => {
    const dir = root();
    const outside = root();
    mkdirSync(join(outside, "sekret"));
    symlinkSync(join(outside, "sekret"), join(dir, "escape"));
    writeFileSync(join(dir, "ok.txt"), "x");
    const { entries } = listWorkspaceDir(dir, "");
    expect(entries.map((e) => e.name)).toEqual(["ok.txt"]); // escape link omitted
  });

  test("throws on a file target (not a directory)", () => {
    const dir = root();
    writeFileSync(join(dir, "f.txt"), "x");
    expect(() => listWorkspaceDir(dir, "f.txt")).toThrow(/not a directory/);
  });

  test("rejects traversal", () => {
    const dir = root();
    expect(() => listWorkspaceDir(dir, "../..")).toThrow(/escapes/);
  });
});

describe("readWorkspaceFile (BRO-1666)", () => {
  test("reads a small text file", () => {
    const dir = root();
    writeFileSync(join(dir, "a.txt"), "hello world");
    const r = readWorkspaceFile(dir, "a.txt");
    expect(r).toMatchObject({
      path: "a.txt",
      content: "hello world",
      truncated: false,
      binary: false,
      size: 11,
    });
  });

  test("reads an empty file", () => {
    const dir = root();
    writeFileSync(join(dir, "empty"), "");
    const r = readWorkspaceFile(dir, "empty");
    expect(r).toMatchObject({ content: "", truncated: false, binary: false, size: 0 });
  });

  test("flags a binary file (NUL byte) with empty content", () => {
    const dir = root();
    writeFileSync(join(dir, "bin"), Buffer.from([0x00, 0x01, 0x02, 0x41]));
    const r = readWorkspaceFile(dir, "bin");
    expect(r.binary).toBe(true);
    expect(r.content).toBe("");
    expect(r.size).toBe(4);
  });

  test("truncates a file over the cap (content is the leading slice)", () => {
    const dir = root();
    const big = "a".repeat(MAX_FILE_BYTES + 100);
    writeFileSync(join(dir, "big.txt"), big);
    const r = readWorkspaceFile(dir, "big.txt");
    expect(r.truncated).toBe(true);
    expect(r.size).toBe(MAX_FILE_BYTES + 100);
    expect(r.content.length).toBe(MAX_FILE_BYTES);
    expect(r.content).toBe("a".repeat(MAX_FILE_BYTES));
  });

  test("throws on a directory target", () => {
    const dir = root();
    mkdirSync(join(dir, "d"));
    expect(() => readWorkspaceFile(dir, "d")).toThrow(/directory/);
  });

  test("rejects traversal + a missing file", () => {
    const dir = root();
    expect(() => readWorkspaceFile(dir, "../secret")).toThrow(/escapes/);
    try {
      readWorkspaceFile(dir, "nope.txt");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as WorkspaceFsError).status).toBe(404);
    }
  });
});

describe("contentTypeFor (BRO-1667)", () => {
  test("maps known extensions to safe MIME types (case-insensitive)", () => {
    expect(contentTypeFor("a.png")).toBe("image/png");
    expect(contentTypeFor("A.JPG")).toBe("image/jpeg");
    expect(contentTypeFor("x.jpeg")).toBe("image/jpeg");
    expect(contentTypeFor("i.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("doc.pdf")).toBe("application/pdf");
    expect(contentTypeFor("page.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("page.htm")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("n.txt")).toBe("text/plain; charset=utf-8");
  });
  test("falls back to octet-stream for unknown / no extension", () => {
    expect(contentTypeFor("archive.zip")).toBe("application/octet-stream");
    expect(contentTypeFor("Makefile")).toBe("application/octet-stream");
    expect(contentTypeFor("weird.exe")).toBe("application/octet-stream");
  });
});

describe("readWorkspaceFileRaw (BRO-1667)", () => {
  test("returns bytes + a name-derived content type", () => {
    const dir = root();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG signature-ish
    writeFileSync(join(dir, "logo.png"), png);
    const r = readWorkspaceFileRaw(dir, "logo.png");
    expect(r.contentType).toBe("image/png");
    expect(r.size).toBe(png.length);
    expect(Buffer.from(r.bytes).equals(png)).toBe(true);
  });

  test("throws 413 for a file over the raw cap", () => {
    const dir = root();
    // Sparse-ish: write a buffer just over the cap (bounded — the test env allows it).
    writeFileSync(join(dir, "big.bin"), Buffer.alloc(MAX_RAW_BYTES + 1));
    try {
      readWorkspaceFileRaw(dir, "big.bin");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as WorkspaceFsError).status).toBe(413);
    }
  });

  test("rejects traversal / directory / missing", () => {
    const dir = root();
    mkdirSync(join(dir, "d"));
    expect(() => readWorkspaceFileRaw(dir, "../etc")).toThrow(/escapes/);
    expect(() => readWorkspaceFileRaw(dir, "d")).toThrow(/directory/);
    try {
      readWorkspaceFileRaw(dir, "nope");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as WorkspaceFsError).status).toBe(404);
    }
  });
});
