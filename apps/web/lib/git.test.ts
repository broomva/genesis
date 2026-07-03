import { describe, expect, test } from "bun:test";
import {
  type GitStatusData,
  fileIsStagedOnly,
  normalizeDiff,
  normalizeStatus,
  statusBadge,
} from "./git";

describe("normalizeStatus (BRO-1666 Slice 2)", () => {
  test("passes a clean status through", () => {
    const out = normalizeStatus({
      isGitRepo: true,
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      truncated: false,
      files: [
        { path: "a.txt", x: "M", y: " ", untracked: false, added: 3, deleted: 1 },
        { path: "new.txt", x: "?", y: "?", untracked: true, added: null, deleted: null },
      ],
    });
    expect(out).toEqual({
      isGitRepo: true,
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      truncated: false,
      files: [
        { path: "a.txt", x: "M", y: " ", untracked: false, added: 3, deleted: 1 },
        { path: "new.txt", x: "?", y: "?", untracked: true, added: null, deleted: null },
      ],
    } satisfies GitStatusData);
  });

  test("drops file entries without a path + coerces garbage fields", () => {
    const out = normalizeStatus({
      files: [
        { x: "M" }, // no path → dropped
        { path: "ok", x: 1, y: null, added: "big", deleted: undefined, untracked: "yes" },
        null,
      ],
    });
    expect(out.files).toEqual([
      { path: "ok", x: " ", y: " ", untracked: false, added: null, deleted: null },
    ]);
  });

  test("preserves a rename's orig + treats absent isGitRepo as a repo", () => {
    const out = normalizeStatus({
      files: [{ path: "new.txt", x: "R", y: " ", untracked: false, orig: "old.txt" }],
    });
    expect(out.isGitRepo).toBe(true);
    expect(out.files[0]).toEqual({
      path: "new.txt",
      x: "R",
      y: " ",
      untracked: false,
      added: null,
      deleted: null,
      orig: "old.txt",
    });
  });

  test("honors isGitRepo:false", () => {
    expect(normalizeStatus({ isGitRepo: false }).isGitRepo).toBe(false);
  });

  test("tolerates an empty/garbage body", () => {
    expect(normalizeStatus(undefined)).toEqual({
      isGitRepo: true,
      branch: undefined,
      upstream: undefined,
      ahead: 0,
      behind: 0,
      files: [],
      truncated: false,
    });
  });
});

describe("normalizeDiff (BRO-1666 Slice 2)", () => {
  test("passes a clean diff through", () => {
    const out = normalizeDiff({
      path: "a.txt",
      diff: "@@ -1 +1 @@\n-a\n+b",
      truncated: false,
      binary: false,
    });
    expect(out).toEqual({
      path: "a.txt",
      diff: "@@ -1 +1 @@\n-a\n+b",
      truncated: false,
      binary: false,
    });
  });
  test("coerces missing fields to safe defaults", () => {
    expect(normalizeDiff({})).toEqual({ path: "", diff: "", truncated: false, binary: false });
  });
});

describe("statusBadge + fileIsStagedOnly (BRO-1666 Slice 2)", () => {
  const f = (over: Partial<GitStatusData["files"][number]>) => ({
    path: "p",
    x: " ",
    y: " ",
    untracked: false,
    added: null,
    deleted: null,
    ...over,
  });
  test("untracked → U", () => {
    expect(statusBadge(f({ untracked: true, x: "?", y: "?" }))).toBe("U");
  });
  test("staged code wins over unstaged", () => {
    expect(statusBadge(f({ x: "A", y: " " }))).toBe("A");
    expect(statusBadge(f({ x: "M", y: "M" }))).toBe("M");
  });
  test("unstaged code when nothing staged", () => {
    expect(statusBadge(f({ x: " ", y: "M" }))).toBe("M");
  });
  test("fileIsStagedOnly is true only for a staged file with no unstaged change", () => {
    expect(fileIsStagedOnly(f({ x: "A", y: " " }))).toBe(true);
    expect(fileIsStagedOnly(f({ x: "M", y: "M" }))).toBe(false);
    expect(fileIsStagedOnly(f({ x: " ", y: "M" }))).toBe(false);
    expect(fileIsStagedOnly(f({ untracked: true, x: "?", y: "?" }))).toBe(false);
  });
});
