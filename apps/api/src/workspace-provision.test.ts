import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableWorkspaces, resolvePick } from "./workspace-provision";

const dirs: string[] = [];
function root(withRepos: string[] = []): string {
  const d = mkdtempSync(join(tmpdir(), "genesis-root-"));
  dirs.push(d);
  for (const r of withRepos) mkdirSync(join(d, r, ".git"), { recursive: true });
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("availableWorkspaces (BRO-1629)", () => {
  test("lists git repos under the allow-root, excluding already-registered ids", () => {
    const dir = root(["alpha", "beta"]);
    mkdirSync(join(dir, "not-a-repo")); // no .git → skipped
    const avail = availableWorkspaces(dir, new Set(["ws-alpha"])); // alpha already registered
    expect(avail.map((a) => a.name)).toEqual(["beta"]);
    expect(avail[0]?.id).toBe("ws-beta");
  });

  test("no allow-root → empty (self-serve add disabled)", () => {
    expect(availableWorkspaces(undefined, new Set())).toEqual([]);
  });
});

describe("resolvePick (BRO-1629 — server derives + validates the path)", () => {
  test("resolves a valid pick to a full Workspace, rootPath derived server-side", () => {
    const dir = root(["myrepo"]);
    expect(resolvePick(dir, "myrepo", new Set())).toEqual({
      id: "ws-myrepo",
      name: "myrepo",
      rootPath: join(dir, "myrepo"),
      isGitRepo: true,
    });
  });

  test("rejects a traversal / unsafe pick — the client never escapes the root", () => {
    const dir = root(["ok"]);
    for (const bad of ["../etc", "a/b", "..", ".hidden", "", "x\\y", 42, null]) {
      expect(() => resolvePick(dir, bad, new Set())).toThrow();
    }
  });

  test("rejects a non-existent or non-git pick", () => {
    const dir = root([]);
    mkdirSync(join(dir, "plain")); // exists but no .git
    expect(() => resolvePick(dir, "ghost", new Set())).toThrow(/not found/);
    expect(() => resolvePick(dir, "plain", new Set())).toThrow(/not a git/);
  });

  test("rejects when no allow-root is configured", () => {
    expect(() => resolvePick(undefined, "x", new Set())).toThrow(/no projects root/);
  });

  test("disambiguates a slug collision deterministically (never overwrites)", () => {
    const dir = root(["My Repo"]); // slugs to ws-my-repo
    const ws = resolvePick(dir, "My Repo", new Set(["ws-my-repo"])); // id already taken
    expect(ws.id).toMatch(/^ws-my-repo-[0-9a-f]{6}$/);
    expect(ws.name).toBe("My Repo");
    expect(ws.rootPath).toBe(join(dir, "My Repo"));
  });
});
