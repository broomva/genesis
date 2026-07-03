import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFsError } from "./workspace-fs";
import { gitCommit, gitDiff, gitStatus } from "./workspace-git";

const dirs: string[] = [];
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}
/** A fresh temp git repo with identity configured (no signing). */
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "genesis-git-"));
  dirs.push(d);
  git(d, "init", "-q");
  git(d, "config", "user.email", "t@example.com");
  git(d, "config", "user.name", "Test");
  git(d, "config", "commit.gpgsign", "false");
  return d;
}
function commit(d: string, message = "c"): void {
  git(d, "add", "-A");
  git(d, "commit", "-qm", message);
}
/** A work repo with a local bare remote as its upstream (so `git push` works
 *  offline). Returns the work tree + the bare remote path. */
function repoWithRemote(): { work: string; remote: string } {
  const base = mkdtempSync(join(tmpdir(), "genesis-gitr-"));
  dirs.push(base);
  const remote = join(base, "remote.git");
  mkdirSync(remote);
  git(remote, "init", "--bare", "-q");
  const work = join(base, "work");
  mkdirSync(work);
  git(work, "init", "-q");
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "Test");
  git(work, "config", "commit.gpgsign", "false");
  writeFileSync(join(work, "seed.txt"), "1\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "seed");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "-u", "origin", "HEAD"); // sets the upstream
  return { work, remote };
}
function headSha(dir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("gitStatus (BRO-1666 Slice 2)", () => {
  test("returns isGitRepo:false for a non-repo directory", async () => {
    const d = mkdtempSync(join(tmpdir(), "genesis-plain-"));
    dirs.push(d);
    const s = await gitStatus(d);
    expect(s.isGitRepo).toBe(false);
    expect(s.files).toEqual([]);
  });

  test("reports the branch + a modified file with +/- counts", async () => {
    const d = repo();
    writeFileSync(join(d, "a.txt"), "line1\nline2\n");
    commit(d, "init");
    writeFileSync(join(d, "a.txt"), "line1\nCHANGED\nline3\n");
    const s = await gitStatus(d);
    expect(s.isGitRepo).toBe(true);
    expect(typeof s.branch).toBe("string");
    expect((s.branch ?? "").length).toBeGreaterThan(0);
    const f = s.files.find((x) => x.path === "a.txt");
    expect(f).toBeDefined();
    expect(f?.y).toBe("M"); // unstaged modification
    expect(f?.untracked).toBe(false);
    expect(f?.added).toBeGreaterThanOrEqual(1);
    expect(f?.deleted).toBeGreaterThanOrEqual(1);
  });

  test("lists an untracked file as untracked", async () => {
    const d = repo();
    writeFileSync(join(d, "seed"), "x");
    commit(d, "seed");
    writeFileSync(join(d, "new.txt"), "hi");
    const s = await gitStatus(d);
    const f = s.files.find((x) => x.path === "new.txt");
    expect(f?.untracked).toBe(true);
    expect(f?.x).toBe("?");
    expect(f?.y).toBe("?");
  });

  test("marks a staged new file as added (A)", async () => {
    const d = repo();
    writeFileSync(join(d, "seed"), "x");
    commit(d, "seed");
    writeFileSync(join(d, "s.txt"), "hi");
    git(d, "add", "s.txt");
    const s = await gitStatus(d);
    const f = s.files.find((x) => x.path === "s.txt");
    expect(f?.x).toBe("A");
  });

  test("refuses a SUBDIRECTORY workspace (P20 HIGH-1 confinement guard)", async () => {
    const d = repo();
    writeFileSync(join(d, "top.txt"), "a\n");
    commit(d, "init");
    writeFileSync(join(d, "top.txt"), "A\n"); // a change ABOVE the subdir
    const sub = join(d, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "inner.txt"), "x\n");
    // Browsing the subdir must NOT resolve the enclosing repo → no leak of top.txt.
    const s = await gitStatus(sub);
    expect(s.isGitRepo).toBe(false);
    expect(s.files).toEqual([]);
  });

  test("captures a rename's original path", async () => {
    const d = repo();
    writeFileSync(join(d, "old.txt"), "same content here\n");
    commit(d, "init");
    git(d, "mv", "old.txt", "renamed.txt");
    const s = await gitStatus(d);
    const f = s.files.find((x) => x.path === "renamed.txt" || x.orig === "old.txt");
    expect(f).toBeDefined();
    expect(f?.x).toBe("R");
    expect(f?.orig).toBe("old.txt");
  });
});

describe("gitDiff (BRO-1666 Slice 2)", () => {
  test("returns a unified diff for an unstaged modification", async () => {
    const d = repo();
    writeFileSync(join(d, "a.txt"), "line1\nline2\n");
    commit(d, "init");
    writeFileSync(join(d, "a.txt"), "line1\nCHANGED\n");
    const r = await gitDiff(d, "a.txt");
    expect(r.path).toBe("a.txt");
    expect(r.binary).toBe(false);
    expect(r.diff).toContain("CHANGED");
    expect(r.diff).toContain("-line2");
  });

  test("--cached shows staged changes; unstaged is empty after staging", async () => {
    const d = repo();
    writeFileSync(join(d, "a.txt"), "one\n");
    commit(d, "init");
    writeFileSync(join(d, "a.txt"), "two\n");
    git(d, "add", "a.txt");
    const staged = await gitDiff(d, "a.txt", { cached: true });
    expect(staged.diff).toContain("+two");
    const unstaged = await gitDiff(d, "a.txt");
    expect(unstaged.diff).toBe("");
  });

  test("flags a binary file", async () => {
    const d = repo();
    writeFileSync(join(d, "bin"), Buffer.from([0x00, 0x01, 0x02]));
    commit(d, "init");
    writeFileSync(join(d, "bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const r = await gitDiff(d, "bin");
    expect(r.binary).toBe(true);
    expect(r.diff).toBe("");
  });

  test("rejects traversal / absolute / empty paths", async () => {
    const d = repo();
    writeFileSync(join(d, "seed"), "x");
    commit(d, "seed");
    await expect(gitDiff(d, "../etc/passwd")).rejects.toThrow(/escapes/);
    await expect(gitDiff(d, "/etc/passwd")).rejects.toThrow(/relative/);
    await expect(gitDiff(d, "")).rejects.toThrow(/required/);
    await expect(gitDiff(d, "a\0b")).rejects.toThrow(WorkspaceFsError);
  });

  test("treats `:/` pathspec magic as a literal filename (P20 HIGH-1: GIT_LITERAL_PATHSPECS)", async () => {
    const d = repo();
    writeFileSync(join(d, "a.txt"), "one\n");
    commit(d, "init");
    writeFileSync(join(d, "a.txt"), "two\n"); // a real change exists in the repo
    // Without GIT_LITERAL_PATHSPECS, `-- :/` would diff the WHOLE repo from its root;
    // with it, `:/` is just a (non-existent) literal filename → empty diff.
    const r = await gitDiff(d, ":/");
    expect(r.diff).toBe("");
  });
});

describe("gitCommit (BRO-1666 Slice 3 — write, owner-only)", () => {
  test("commits all changes + pushes to the configured upstream", async () => {
    const { work, remote } = repoWithRemote();
    writeFileSync(join(work, "seed.txt"), "2\n");
    writeFileSync(join(work, "extra.txt"), "new\n"); // untracked → add -A stages it too
    const r = await gitCommit(work, { message: "dogfood change", push: true });
    expect(r.committed).toBe(true);
    expect(r.pushed).toBe(true);
    expect(r.pushError).toBeUndefined();
    expect(r.sha.length).toBeGreaterThan(0);
    // The bare remote received the new commit.
    expect(headSha(remote)).toBe(headSha(work));
    expect(headSha(work)).toBe(r.sha);
  });

  test("commits without pushing when push is false", async () => {
    const { work, remote } = repoWithRemote();
    const before = headSha(remote);
    writeFileSync(join(work, "seed.txt"), "3\n");
    const r = await gitCommit(work, { message: "local only", push: false });
    expect(r.committed).toBe(true);
    expect(r.pushed).toBe(false);
    expect(headSha(remote)).toBe(before); // remote unchanged
    expect(headSha(work)).toBe(r.sha); // work advanced
  });

  test("treats a flag-like message as a literal message (no arg injection)", async () => {
    const { work } = repoWithRemote();
    writeFileSync(join(work, "seed.txt"), "4\n");
    await gitCommit(work, { message: "--no-verify --amend", push: false });
    const subject = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: work }).toString();
    expect(subject).toContain("--no-verify --amend"); // it's the message, not flags
  });

  test("rejects an empty / whitespace / over-long message", async () => {
    const { work } = repoWithRemote();
    await expect(gitCommit(work, { message: "" })).rejects.toThrow(/required/);
    await expect(gitCommit(work, { message: "   " })).rejects.toThrow(/required/);
    await expect(gitCommit(work, { message: 42 as unknown })).rejects.toThrow(/required/);
    await expect(gitCommit(work, { message: "x".repeat(5000) })).rejects.toThrow(/too long/);
  });

  test("nothing to commit → 400", async () => {
    const { work } = repoWithRemote(); // clean after the seed commit
    await expect(gitCommit(work, { message: "noop", push: false })).rejects.toThrow(
      /nothing to commit/,
    );
  });

  test("commit succeeds but push fails (no upstream) → committed:true, pushError set", async () => {
    const d = repo(); // a repo with NO remote/upstream
    writeFileSync(join(d, "a.txt"), "x\n");
    commit(d, "init");
    writeFileSync(join(d, "a.txt"), "y\n");
    const r = await gitCommit(d, { message: "change", push: true });
    expect(r.committed).toBe(true);
    expect(r.pushed).toBe(false);
    expect(r.pushError).toBeDefined();
  });

  test("refuses a subdirectory workspace (confinement)", async () => {
    const { work } = repoWithRemote();
    const sub = join(work, "sub");
    mkdirSync(sub);
    await expect(gitCommit(sub, { message: "x", push: false })).rejects.toThrow(
      /not a git repository/,
    );
  });
});
