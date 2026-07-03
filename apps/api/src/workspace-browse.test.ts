import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browseForAdd } from "./workspace-browse";
import { WorkspaceValidationError } from "./workspace-provision";

const dirs: string[] = [];
/** A fresh tmp root (realpath'd — macOS /tmp is a symlink to /private/tmp, and the
 *  browse boundary is realpath-based, so tests must compare against the real path). */
function root(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "genesis-browse-")));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("browseForAdd (BRO-1673)", () => {
  test("lists immediate subdirectories (dirs only), sorted, git-flagged", () => {
    const r = root();
    mkdirSync(join(r, "beta"));
    mkdirSync(join(r, "alpha", ".git"), { recursive: true }); // a git repo
    writeFileSync(join(r, "a-file.txt"), "x"); // a file → not listed
    const res = browseForAdd(r, [r]);
    expect(res.path).toBe(r);
    expect(res.parent).toBeNull(); // at the root → can't navigate up
    expect(res.registerable).toBe(true);
    expect(res.entries.map((e) => e.name)).toEqual(["alpha", "beta"]); // sorted, no file
    expect(res.entries.find((e) => e.name === "alpha")?.isGitRepo).toBe(true);
    expect(res.entries.find((e) => e.name === "beta")?.isGitRepo).toBe(false);
    expect(res.entries.find((e) => e.name === "alpha")?.path).toBe(join(r, "alpha"));
  });

  test("descending into a subdir exposes a parent to navigate up to", () => {
    const r = root();
    mkdirSync(join(r, "proj", "src"), { recursive: true });
    const res = browseForAdd(join(r, "proj"), [r]);
    expect(res.path).toBe(join(r, "proj"));
    expect(res.parent).toBe(r); // one level down → parent is the root
    expect(res.entries.map((e) => e.name)).toEqual(["src"]);
  });

  test("no path + a single root → descends straight into it (skips a tap)", () => {
    const r = root();
    mkdirSync(join(r, "x"));
    const res = browseForAdd(undefined, [r]);
    expect(res.path).toBe(r);
    expect(res.registerable).toBe(true);
    expect(res.entries.map((e) => e.name)).toEqual(["x"]);
  });

  test("no path + multiple roots → a synthetic, non-registerable top level of the roots", () => {
    const a = root();
    const b = root();
    const res = browseForAdd("", [a, b]);
    expect(res.path).toBeNull();
    expect(res.parent).toBeNull();
    expect(res.registerable).toBe(false); // "all roots" isn't a folder you can register
    expect(res.entries.map((e) => e.path).sort()).toEqual([a, b].sort());
  });

  // ─── Sandbox: the load-bearing rejections ────────────────────────────────────
  test("an absolute path OUTSIDE every root is rejected", () => {
    const r = root();
    expect(() => browseForAdd("/etc", [r])).toThrow(WorkspaceValidationError);
  });

  test("`..` traversal that escapes the root is rejected (normalized before resolve)", () => {
    const r = root();
    mkdirSync(join(r, "sub"));
    expect(() => browseForAdd(join(r, "sub", "..", "..", ".."), [r])).toThrow(
      WorkspaceValidationError,
    );
  });

  test("a symlink INSIDE the root pointing OUTSIDE is rejected as a browse target", () => {
    const r = root();
    const outside = root(); // a sibling, not under r
    symlinkSync(outside, join(r, "escape"));
    expect(() => browseForAdd(join(r, "escape"), [r])).toThrow(WorkspaceValidationError);
  });

  test("a symlink-to-outside is HIDDEN from a listing (not surfaced as an entry)", () => {
    const r = root();
    const outside = root();
    mkdirSync(join(r, "real"));
    symlinkSync(outside, join(r, "escape")); // in-root name, out-of-root target
    const res = browseForAdd(r, [r]);
    expect(res.entries.map((e) => e.name)).toEqual(["real"]); // escape hidden
  });

  test("a relative path is rejected (only absolute paths navigate)", () => {
    const r = root();
    expect(() => browseForAdd("sub", [r])).toThrow(WorkspaceValidationError);
  });

  test("a path to a FILE (not a directory) is rejected", () => {
    const r = root();
    writeFileSync(join(r, "f.txt"), "x");
    expect(() => browseForAdd(join(r, "f.txt"), [r])).toThrow(WorkspaceValidationError);
  });

  test("a non-existent path is rejected as not found", () => {
    const r = root();
    expect(() => browseForAdd(join(r, "nope"), [r])).toThrow(WorkspaceValidationError);
  });

  test("no usable roots → browsing is disabled", () => {
    expect(() => browseForAdd(undefined, [])).toThrow(WorkspaceValidationError);
    expect(() => browseForAdd(undefined, ["/does/not/exist"])).toThrow(WorkspaceValidationError);
  });

  test("a non-string path is rejected", () => {
    const r = root();
    expect(() => browseForAdd(42, [r])).toThrow(WorkspaceValidationError);
  });

  // P20 review #2/#4: an unreadable in-root dir must surface as a SAFE WorkspaceValidationError
  // (→ route 400), not an unwrapped EACCES that maps to a generic 500. Root bypasses perms,
  // so skip the assertion there (CI may run as root).
  test("an unreadable in-root directory → a safe validation error (no unwrapped throw)", () => {
    if (process.getuid?.() === 0) return; // root ignores the perm bits
    const r = root();
    const locked = join(r, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      let threw: unknown;
      try {
        browseForAdd(locked, [r]);
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeInstanceOf(WorkspaceValidationError);
      // The safe message never carries the absolute path (no filesystem-layout leak).
      expect((threw as Error).message).not.toContain("/");
    } finally {
      chmodSync(locked, 0o700); // restore so afterEach can rm it
    }
  });
});
