import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GitUrlPolicy,
  availableWorkspaces,
  defaultGitUrlPolicy,
  pathAddRoots,
  provisionFromGitUrl,
  purgeCloneTmp,
  resolveGitUrl,
  resolvePathAdd,
  resolvePick,
} from "./workspace-provision";

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

  test("rejects a symlink inside the root pointing OUTSIDE it — hard boundary (P20 Forge SF1)", () => {
    const outside = root([]);
    mkdirSync(join(outside, "external", ".git"), { recursive: true }); // a real git repo, out of root
    const dir = root([]);
    symlinkSync(join(outside, "external"), join(dir, "linked"), "dir");
    // "linked" is LEXICALLY inside `dir` but its realpath is under `outside` → the
    // realpath re-check must reject it (the .git check follows the symlink + passes).
    expect(() => resolvePick(dir, "linked", new Set())).toThrow(
      /outside the projects root|symlink/,
    );
  });
});

// ─── Add-by-git-URL (BRO-1629 slice 5) ────────────────────────────────────────
const POLICY: GitUrlPolicy = {
  allowedHosts: new Set(["github.com", "gitlab.com"]),
  cloneTimeoutMs: 5_000,
};

describe("resolveGitUrl — SSRF / scheme / credential rejection matrix", () => {
  test("resolves a valid https URL → server-derived target inside the allow-root", () => {
    const dir = root([]);
    expect(resolveGitUrl(dir, "https://github.com/broomva/genesis.git", new Set(), POLICY)).toEqual(
      {
        url: "https://github.com/broomva/genesis.git",
        name: "genesis",
        targetPath: join(dir, "genesis"),
        id: "ws-genesis",
      },
    );
  });

  test("derives the leaf name whether or not the URL ends in .git", () => {
    const dir = root([]);
    expect(resolveGitUrl(dir, "https://gitlab.com/foo/bar", new Set(), POLICY).name).toBe("bar");
    expect(resolveGitUrl(dir, "https://gitlab.com/foo/Bar.git", new Set(), POLICY).name).toBe(
      "bar",
    );
  });

  test("rejects a non-https scheme (file/ssh/git/http)", () => {
    const dir = root([]);
    for (const bad of [
      "file:///etc/passwd",
      "ssh://git@github.com/x/y.git",
      "git://github.com/x/y.git",
      "http://github.com/x/y.git",
    ]) {
      expect(() => resolveGitUrl(dir, bad, new Set(), POLICY)).toThrow(/https/);
    }
  });

  test("rejects embedded credentials (user:pass@host)", () => {
    const dir = root([]);
    expect(() =>
      resolveGitUrl(dir, "https://user:tok@github.com/x/y.git", new Set(), POLICY),
    ).toThrow(/credential/);
  });

  test("rejects a host that isn't allowlisted — the SSRF firewall", () => {
    const dir = root([]);
    // localhost, loopback, RFC-1918, link-local, cloud metadata, and any random host
    // are all rejected purely by NOT being in the allowlist (no IP denylist needed).
    for (const bad of [
      "https://localhost/x/y.git",
      "https://127.0.0.1/x/y.git",
      "https://10.0.0.5/x/y.git",
      "https://192.168.1.1/x/y.git",
      "https://169.254.169.254/latest/meta-data",
      "https://evil.example.com/x/y.git",
    ]) {
      expect(() => resolveGitUrl(dir, bad, new Set(), POLICY)).toThrow(/not allowed/);
    }
  });

  test("rejects a non-default port (SSRF-pivot smell)", () => {
    const dir = root([]);
    expect(() => resolveGitUrl(dir, "https://github.com:22/x/y.git", new Set(), POLICY)).toThrow(
      /port/,
    );
  });

  test("rejects a query string or fragment (blocks ?token= credential smuggling)", () => {
    const dir = root([]);
    for (const bad of [
      "https://github.com/x/y.git?token=secret",
      "https://github.com/x/y.git?access_token=abc",
      "https://github.com/x/y.git#frag",
    ]) {
      expect(() => resolveGitUrl(dir, bad, new Set(), POLICY)).toThrow(/query string or fragment/);
    }
  });

  test("accepts a trailing FQDN dot on the host (normalized to the allowlist form)", () => {
    const dir = root([]);
    // `github.com.` is a valid absolute-DNS spelling git resolves fine — it must match
    // the `github.com` allowlist entry, not be wrongly rejected (P20 CRIT-1 / MED-1).
    const ws = resolveGitUrl(dir, "https://github.com./broomva/genesis.git", new Set(), POLICY);
    expect(ws.name).toBe("genesis");
    // A trailing dot on a NON-allowlisted host is still rejected (no widening).
    expect(() =>
      resolveGitUrl(dir, "https://evil.example.com./x/y.git", new Set(), POLICY),
    ).toThrow(/not allowed/);
  });

  test("rejects a malformed / empty / oversized / non-string URL", () => {
    const dir = root([]);
    for (const bad of [
      "",
      "not a url",
      "https://",
      `https://github.com/${"x".repeat(2100)}`,
      42,
      null,
    ]) {
      expect(() => resolveGitUrl(dir, bad, new Set(), POLICY)).toThrow();
    }
  });

  test("rejects a URL with no derivable repo name", () => {
    const dir = root([]);
    expect(() => resolveGitUrl(dir, "https://github.com/", new Set(), POLICY)).toThrow(
      /project name|not allowed/,
    );
  });

  test("rejects when no allow-root is configured", () => {
    expect(() => resolveGitUrl(undefined, "https://github.com/x/y.git", new Set(), POLICY)).toThrow(
      /no projects root/,
    );
  });

  test("disambiguates a slug collision deterministically (never overwrites)", () => {
    const dir = root([]);
    const ws = resolveGitUrl(
      dir,
      "https://github.com/a/genesis.git",
      new Set(["ws-genesis"]),
      POLICY,
    );
    expect(ws.id).toMatch(/^ws-genesis-[0-9a-f]{6}$/);
    expect(ws.name).toBe("genesis");
    expect(ws.targetPath).toBe(join(dir, "genesis"));
  });
});

describe("defaultGitUrlPolicy", () => {
  test("unions GENESIS_GIT_URL_HOSTS into the built-in allowlist", () => {
    const p = defaultGitUrlPolicy({ GENESIS_GIT_URL_HOSTS: "git.acme.internal, Codeberg.org " });
    expect(p.allowedHosts.has("github.com")).toBe(true); // built-in preserved
    expect(p.allowedHosts.has("git.acme.internal")).toBe(true); // added
    expect(p.allowedHosts.has("codeberg.org")).toBe(true); // lower-cased + trimmed
  });

  test("normalizes a trailing FQDN dot on an allowlist entry (no foot-gun)", () => {
    const p = defaultGitUrlPolicy({ GENESIS_GIT_URL_HOSTS: "git.acme.internal." });
    expect(p.allowedHosts.has("git.acme.internal")).toBe(true); // dot stripped, not "…internal."
  });

  test("defaults the clone timeout when env is missing/invalid", () => {
    expect(defaultGitUrlPolicy({}).cloneTimeoutMs).toBe(120_000);
    expect(defaultGitUrlPolicy({ GENESIS_GIT_CLONE_TIMEOUT_MS: "abc" }).cloneTimeoutMs).toBe(
      120_000,
    );
    expect(defaultGitUrlPolicy({ GENESIS_GIT_CLONE_TIMEOUT_MS: "5000" }).cloneTimeoutMs).toBe(
      5_000,
    );
  });

  test("clamps an absurd timeout to the 10-minute ceiling", () => {
    expect(defaultGitUrlPolicy({ GENESIS_GIT_CLONE_TIMEOUT_MS: "999999999" }).cloneTimeoutMs).toBe(
      600_000,
    );
  });
});

describe("provisionFromGitUrl — clone then register (clone mocked)", () => {
  test("clones into the allow-root and returns a bindable Workspace", async () => {
    const dir = root([]);
    const cloned: Array<{ url: string; target: string }> = [];
    const clone = async (url: string, target: string) => {
      cloned.push({ url, target });
      mkdirSync(join(target, ".git"), { recursive: true }); // simulate a checkout
    };
    const ws = await provisionFromGitUrl(dir, "https://github.com/broomva/genesis.git", new Set(), {
      policy: POLICY,
      clone,
    });
    expect(ws).toEqual({
      id: "ws-genesis",
      name: "genesis",
      rootPath: join(dir, "genesis"),
      isGitRepo: true,
    });
    // The repo landed at its final path (atomically renamed out of the temp dir).
    expect(existsSync(join(dir, "genesis", ".git"))).toBe(true);
    // The clone was directed at a TEMP path, not the final target (temp+rename).
    expect(cloned[0]?.target).not.toBe(join(dir, "genesis"));
    expect(cloned[0]?.url).toBe("https://github.com/broomva/genesis.git");
  });

  test("refuses to clobber an existing directory (never clones over it)", async () => {
    const dir = root([]);
    mkdirSync(join(dir, "genesis")); // destination already occupied
    let cloneCalled = false;
    const clone = async () => {
      cloneCalled = true;
    };
    await expect(
      provisionFromGitUrl(dir, "https://github.com/x/genesis.git", new Set(), {
        policy: POLICY,
        clone,
      }),
    ).rejects.toThrow(/already exists/);
    expect(cloneCalled).toBe(false); // failed fast, before the clone
  });

  test("a failed clone leaves no residue under the allow-root", async () => {
    const dir = root([]);
    const clone = async () => {
      throw new Error("fatal: repository not found");
    };
    await expect(
      provisionFromGitUrl(dir, "https://github.com/x/ghost.git", new Set(), {
        policy: POLICY,
        clone,
      }),
    ).rejects.toThrow(/clone failed/);
    expect(existsSync(join(dir, "ghost"))).toBe(false); // no partial target
    // The temp quarantine dir is either gone or empty (the partial temp was rm'd).
    const tmpRoot = join(dir, ".genesis-clone-tmp");
    if (existsSync(tmpRoot)) expect(readdirSync(tmpRoot)).toEqual([]);
  });

  test("a clone that produces no .git is rejected + cleaned up", async () => {
    const dir = root([]);
    const clone = async (_url: string, target: string) => {
      mkdirSync(target, { recursive: true }); // empty dir, no .git
    };
    await expect(
      provisionFromGitUrl(dir, "https://github.com/x/empty.git", new Set(), {
        policy: POLICY,
        clone,
      }),
    ).rejects.toThrow(/not produce a git repository/);
    expect(existsSync(join(dir, "empty"))).toBe(false);
  });

  test("an INFRA error (git missing / ENOSPC) is rethrown as-is → route 500, not a 400", async () => {
    const dir = root([]);
    const clone = async () => {
      const err = new Error("spawn git ENOENT") as Error & { code: string };
      err.code = "ENOENT"; // string code = Node system error, not a git non-zero exit
      throw err;
    };
    // NOT a WorkspaceValidationError (which the route would 400) — the raw error
    // propagates so server.ts logs it + returns 500 (CodeRabbit: infra ≠ bad input).
    await expect(
      provisionFromGitUrl(dir, "https://github.com/x/y.git", new Set(), { policy: POLICY, clone }),
    ).rejects.toThrow(/ENOENT/);
    expect(existsSync(join(dir, "y"))).toBe(false); // temp still cleaned up
  });
});

describe("purgeCloneTmp (P20 HIGH-2 — boot-sweep orphaned partial clones)", () => {
  test("removes an orphaned quarantine dir, leaves real workspaces untouched", () => {
    const dir = root([]);
    mkdirSync(join(dir, ".genesis-clone-tmp", "12345.deadbeef", ".git"), { recursive: true });
    mkdirSync(join(dir, "real-repo", ".git"), { recursive: true }); // a registered workspace
    purgeCloneTmp(dir);
    expect(existsSync(join(dir, ".genesis-clone-tmp"))).toBe(false); // orphan swept
    expect(existsSync(join(dir, "real-repo", ".git"))).toBe(true); // untouched
  });

  test("no-op when the allow-root is undefined or the quarantine is absent", () => {
    expect(() => purgeCloneTmp(undefined)).not.toThrow();
    expect(() => purgeCloneTmp(root([]))).not.toThrow(); // no .genesis-clone-tmp present
  });
});

describe("pathAddRoots (BRO-1663)", () => {
  test("defaults to $HOME when no override", () => {
    expect(pathAddRoots({ HOME: "/home/agent" })).toEqual(["/home/agent"]);
  });

  test("GENESIS_WORKSPACE_PATH_ROOTS overrides, colon-separated", () => {
    expect(pathAddRoots({ HOME: "/home/agent", GENESIS_WORKSPACE_PATH_ROOTS: "/a:/b/c" })).toEqual([
      "/a",
      "/b/c",
    ]);
  });

  test("drops relative / blank roots (an empty base would make the boundary meaningless)", () => {
    expect(pathAddRoots({ GENESIS_WORKSPACE_PATH_ROOTS: "/ok: :relative:/two" })).toEqual([
      "/ok",
      "/two",
    ]);
  });

  test("empty when neither HOME nor an override is set → feature OFF", () => {
    expect(pathAddRoots({})).toEqual([]);
  });
});

describe("resolvePathAdd (BRO-1663 — owner-only, sandboxed to the add-roots)", () => {
  // A tmp add-root with a nested target dir; returns [root, targetAbsPath].
  function rootWithDir(name: string, opts: { git?: boolean } = {}): [string, string] {
    const r = mkdtempSync(join(tmpdir(), "genesis-add-"));
    dirs.push(r);
    const target = join(r, name);
    mkdirSync(opts.git ? join(target, ".git") : target, { recursive: true });
    return [r, target];
  }

  test("resolves a valid folder under a root → Workspace (git detected)", () => {
    const [r, target] = rootWithDir("broomva", { git: true });
    // rootPath is the REALPATH (symlink-safe canonicalization) — on macOS the tmpdir
    // /var/… resolves to /private/var/…, which is the correct stored path.
    expect(resolvePathAdd(target, [r], new Set())).toEqual({
      id: "ws-broomva",
      name: "broomva",
      rootPath: realpathSync(target),
      isGitRepo: true,
    });
  });

  test("a non-git folder is still a valid root-only workspace (isGitRepo false)", () => {
    const [r, target] = rootWithDir("notes");
    expect(resolvePathAdd(target, [r], new Set())).toMatchObject({
      id: "ws-notes",
      isGitRepo: false,
    });
  });

  test("rejects when no roots are configured (feature off)", () => {
    const [, target] = rootWithDir("x");
    expect(() => resolvePathAdd(target, [], new Set())).toThrow(/not enabled/);
  });

  test("rejects a non-absolute / empty / non-string / null-byte path", () => {
    const [r] = rootWithDir("x");
    for (const bad of ["relative/path", "", "..", 42, null, undefined, "/a\0b"]) {
      expect(() => resolvePathAdd(bad, [r], new Set())).toThrow();
    }
  });

  test("rejects a path OUTSIDE every root", () => {
    const [r] = rootWithDir("inside");
    const [, outside] = rootWithDir("elsewhere"); // a different tmp root
    expect(() => resolvePathAdd(outside, [r], new Set())).toThrow(/outside the allowed roots/);
  });

  test("rejects a non-existent path", () => {
    const [r] = rootWithDir("x");
    expect(() => resolvePathAdd(join(r, "does-not-exist"), [r], new Set())).toThrow(/not found/);
  });

  test("rejects a file (not a directory)", () => {
    const [r] = rootWithDir("x");
    const file = join(r, "a-file.txt");
    writeFileSync(file, "hi");
    expect(() => resolvePathAdd(file, [r], new Set())).toThrow(/not a directory/);
  });

  test("HARD sandbox: a symlink INSIDE a root pointing OUTSIDE is rejected (symlink-escape)", () => {
    const [r] = rootWithDir("real");
    const outside = mkdtempSync(join(tmpdir(), "genesis-escape-"));
    dirs.push(outside);
    const link = join(r, "escape");
    symlinkSync(outside, link); // lexically under r, but realpath is outside
    expect(() => resolvePathAdd(link, [r], new Set())).toThrow(/outside the allowed roots/);
  });

  test("a symlinked ROOT still bounds correctly (realRoot uses realpath)", () => {
    const [real, target] = rootWithDir("proj", { git: true });
    const linkedRoot = mkdtempSync(join(tmpdir(), "genesis-linkroot-")); // will be replaced by a symlink
    rmSync(linkedRoot, { recursive: true, force: true });
    symlinkSync(real, linkedRoot);
    dirs.push(linkedRoot);
    // The root is a symlink to `real`; a target under `real` must still resolve as under it.
    expect(resolvePathAdd(target, [linkedRoot], new Set())).toMatchObject({ id: "ws-proj" });
  });

  test("normalizes .. before the boundary check (can't climb out with ../)", () => {
    const [r, target] = rootWithDir("proj");
    // target/../proj → target (still under r) → OK, not an escape.
    expect(resolvePathAdd(join(target, "..", "proj"), [r], new Set())).toMatchObject({
      id: "ws-proj",
    });
    // target/../.. → the tmp parent of r → OUTSIDE r → rejected.
    expect(() => resolvePathAdd(join(target, "..", ".."), [r], new Set())).toThrow(
      /outside the allowed roots/,
    );
  });

  test("disambiguates an id collision by path hash (never overwrites a different path)", () => {
    const [r, target] = rootWithDir("dup", { git: true });
    const ws = resolvePathAdd(target, [r], new Set(["ws-dup"]));
    expect(ws.id).toMatch(/^ws-dup-[0-9a-f]{6}$/);
  });
});
