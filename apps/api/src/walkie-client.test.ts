// The static resolver, and mostly what it REFUSES. (BRO-2416)
//
// This maps attacker-controlled path text onto a filesystem. Everything below the
// first two tests is a way that has gone wrong for other people.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAsset } from "./walkie-client";

let root: string;
let outside: string;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "walkie-client-"));
  root = join(base, "dist");
  outside = join(base, "secrets");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html>");
  writeFileSync(join(root, "app.js"), "console.log(1)");
  writeFileSync(join(outside, "id_rsa"), "PRIVATE KEY");
  // A sibling whose name STARTS with the root's — the case a bare startsWith
  // check lets through.
  mkdirSync(`${root}-evil`, { recursive: true });
  writeFileSync(join(`${root}-evil`, "app.js"), "pwned");
});
afterEach(() => rmSync(join(root, ".."), { recursive: true, force: true }));

describe("it serves what it should", () => {
  test("a file in the root resolves with its type", () => {
    expect(resolveAsset(root, "/app.js")?.type).toBe("text/javascript; charset=utf-8");
  });

  test("the root and any directory path resolve to index.html", () => {
    expect(resolveAsset(root, "/")?.path.endsWith("index.html")).toBe(true);
    expect(resolveAsset(root, "")?.path.endsWith("index.html")).toBe(true);
  });
});

describe("it refuses everything else", () => {
  test("plain traversal", () => {
    expect(resolveAsset(root, "/../secrets/id_rsa")).toBeUndefined();
    expect(resolveAsset(root, "/../../etc/passwd")).toBeUndefined();
  });

  test("traversal that only appears after decoding", () => {
    // The router decodes before this sees it, so `%2e%2e` arrives as `..`. A
    // check that scanned the RAW string for ".." would pass this through; the
    // check here is on the RESOLVED path, which is a property of the answer.
    expect(resolveAsset(root, decodeURIComponent("/%2e%2e/secrets/id_rsa"))).toBeUndefined();
    expect(resolveAsset(root, decodeURIComponent("/%2e%2e%2fsecrets%2fid_rsa"))).toBeUndefined();
  });

  test("an absolute path", () => {
    expect(resolveAsset(root, join(outside, "id_rsa"))).toBeUndefined();
  });

  test("A SIBLING DIRECTORY WHOSE NAME STARTS WITH THE ROOT'S", () => {
    // `…/dist-evil` beside `…/dist`. A bare `startsWith(base)` accepts this; the
    // separator in `${base}${sep}` is what makes it a path check rather than a
    // string check.
    expect(resolveAsset(root, "/../dist-evil/app.js")).toBeUndefined();
  });

  test("a symlink pointing out of the tree", () => {
    // Resolution follows it, so the answer lands outside the root and is refused
    // — which a string check on the request path could never do.
    symlinkSync(join(outside, "id_rsa"), join(root, "link.js"));
    expect(resolveAsset(root, "/link.js")).toBeUndefined();
  });

  test("a directory is not an asset — even one named like a file", () => {
    // `/assets` was the first version of this and the mutant SURVIVED it: a
    // directory with no dot has no extension, so the type allowlist already
    // rejected it and the isDirectory check was doing nothing. A directory named
    // `bundle.js` is the only input where that check is load-bearing — contrived
    // to create, trivial for a build tool to produce, and the reason the check
    // exists at all.
    mkdirSync(join(root, "assets"));
    expect(resolveAsset(root, "/assets")).toBeUndefined();
    mkdirSync(join(root, "bundle.js"));
    expect(resolveAsset(root, "/bundle.js")).toBeUndefined();
  });

  test("an extension outside the allowlist", () => {
    // An unknown type is a file this route was never meant to serve. Guessing a
    // content type is how a build directory becomes arbitrary downloads.
    writeFileSync(join(root, "notes.md"), "# secret");
    writeFileSync(join(root, ".env"), "TOKEN=1");
    expect(resolveAsset(root, "/notes.md")).toBeUndefined();
    expect(resolveAsset(root, "/.env")).toBeUndefined();
  });

  test("a file that does not exist", () => {
    expect(resolveAsset(root, "/nope.js")).toBeUndefined();
  });
});
