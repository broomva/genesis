import { describe, expect, test } from "bun:test";
import { type ScannedRepo, discoverWorkspaces, slugifyWorkspace } from "./workspaces";

const noScan = (): ScannedRepo[] => [];
const scanOf = (repos: ScannedRepo[]) => (): ScannedRepo[] => repos;

describe("slugifyWorkspace (BRO-1627)", () => {
  test("lowercases, dashes non-alnum, trims edge/duplicate separators", () => {
    expect(slugifyWorkspace("My Repo")).toBe("my-repo");
    expect(slugifyWorkspace("foo_bar")).toBe("foo-bar");
    expect(slugifyWorkspace("Foo.Bar-2")).toBe("foo-bar-2");
    expect(slugifyWorkspace("--weird__name--")).toBe("weird-name");
  });
  test("falls back to 'ws' when nothing alphanumeric remains", () => {
    expect(slugifyWorkspace("---")).toBe("ws");
    expect(slugifyWorkspace("")).toBe("ws");
  });
});

describe("discoverWorkspaces (BRO-1627)", () => {
  test("unconfigured env → empty (single-workspace behavior preserved)", () => {
    expect(discoverWorkspaces({}, noScan)).toEqual([]);
  });

  test("scans a projects root into ws-<slug> git workspaces, sorted by path", () => {
    const out = discoverWorkspaces(
      { GENESIS_PROJECTS_ROOT: "/p" },
      scanOf([
        { name: "beta", rootPath: "/p/beta" },
        { name: "alpha", rootPath: "/p/alpha" },
      ]),
    );
    expect(out.map((w) => w.id)).toEqual(["ws-alpha", "ws-beta"]); // sorted by rootPath
    expect(out.every((w) => w.isGitRepo === true)).toBe(true);
    expect(out.find((w) => w.id === "ws-alpha")?.rootPath).toBe("/p/alpha");
  });

  test("slug collisions keep BOTH repos, disambiguating deterministically (S2)", () => {
    const out = discoverWorkspaces(
      { GENESIS_PROJECTS_ROOT: "/p" },
      scanOf([
        { name: "Foo Bar", rootPath: "/p/a" },
        { name: "foo_bar", rootPath: "/p/b" },
      ]),
    );
    expect(out.length).toBe(2); // nothing silently dropped
    const ids = out.map((w) => w.id);
    expect(new Set(ids).size).toBe(2); // unique ids
    expect(ids.filter((i) => i.startsWith("ws-foo-bar")).length).toBe(2);
    // Deterministic: same input → same disambiguated id.
    const again = discoverWorkspaces(
      { GENESIS_PROJECTS_ROOT: "/p" },
      scanOf([
        { name: "Foo Bar", rootPath: "/p/a" },
        { name: "foo_bar", rootPath: "/p/b" },
      ]),
    );
    expect(again.map((w) => w.id)).toEqual(ids);
  });

  test("explicit GENESIS_WORKSPACES adds workspaces (incl. noWorktree)", () => {
    const out = discoverWorkspaces({
      GENESIS_WORKSPACES: JSON.stringify([
        { id: "ws-mono", name: "mono", rootPath: "/m", noWorktree: true },
      ]),
    });
    expect(out.length).toBe(1);
    expect(out[0]?.id).toBe("ws-mono");
    expect(out[0]?.rootPath).toBe("/m");
    expect(out[0]?.noWorktree).toBe(true);
  });

  test("an explicit id failing the wire charset guard is skipped (S3)", () => {
    const out = discoverWorkspaces({
      GENESIS_WORKSPACES: JSON.stringify([
        { id: "my repo", name: "x", rootPath: "/x" }, // space → invalid
        { id: "--x", name: "y", rootPath: "/y" }, // leading dash → invalid
        { id: "ws-ok", name: "z", rootPath: "/z" }, // valid
      ]),
    });
    expect(out.map((w) => w.id)).toEqual(["ws-ok"]);
  });

  test("garbage / non-array JSON is ignored, never thrown", () => {
    expect(discoverWorkspaces({ GENESIS_WORKSPACES: "{not json" })).toEqual([]);
    expect(discoverWorkspaces({ GENESIS_WORKSPACES: '{"id":"ws-x"}' })).toEqual([]); // object, not array
  });

  test("entries missing required string fields are skipped", () => {
    const out = discoverWorkspaces({
      GENESIS_WORKSPACES: JSON.stringify([
        { id: "ws-a", name: "a" }, // no rootPath
        { id: "ws-b", name: "b", rootPath: 5 }, // rootPath not a string
        { id: "ws-c", name: "c", rootPath: "/c" }, // ok
      ]),
    });
    expect(out.map((w) => w.id)).toEqual(["ws-c"]);
  });

  test("an explicit entry overrides a scanned one with the same id", () => {
    const out = discoverWorkspaces(
      {
        GENESIS_PROJECTS_ROOT: "/p",
        GENESIS_WORKSPACES: JSON.stringify([
          { id: "ws-alpha", name: "alpha", rootPath: "/override", noWorktree: true },
        ]),
      },
      scanOf([{ name: "alpha", rootPath: "/p/alpha" }]),
    );
    const alpha = out.find((w) => w.id === "ws-alpha");
    expect(alpha?.rootPath).toBe("/override");
    expect(alpha?.noWorktree).toBe(true);
  });
});
