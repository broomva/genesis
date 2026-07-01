import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsWorkspaceRepository } from "./workspace-repository-fs";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "genesis-ws-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// git off in tests → no commit side effects; the files are durable regardless.
const repo = (dir: string) => new FsWorkspaceRepository(dir, false);

describe("FsWorkspaceRepository (BRO-1629)", () => {
  test("register → list → get; DURABLE across instances (survives a 'restart')", async () => {
    const dir = tmp();
    const r1 = repo(dir);
    await r1.register({ id: "ws-b", name: "beta", rootPath: "/repos/beta" });
    await r1.register({ id: "ws-a", name: "alpha", rootPath: "/repos/alpha", noWorktree: true });
    expect((await r1.list()).map((w) => w.id)).toEqual(["ws-a", "ws-b"]); // sorted by id
    // A NEW instance on the same dir sees the manifests — no in-memory state carried.
    const r2 = repo(dir);
    const got = await r2.get("ws-a");
    expect(got?.rootPath).toBe("/repos/alpha");
    expect(got?.noWorktree).toBe(true);
    expect((await r2.list()).map((w) => w.id)).toEqual(["ws-a", "ws-b"]);
  });

  test("remove de-registers; idempotent on a missing id", async () => {
    const r = repo(tmp());
    await r.register({ id: "ws-x", name: "x", rootPath: "/x" });
    await r.remove("ws-x");
    expect(await r.get("ws-x")).toBeUndefined();
    await r.remove("ws-gone"); // no throw
    expect(await r.list()).toEqual([]);
  });

  test("rejects an unsafe id that would escape the manifest dir", async () => {
    const r = repo(tmp());
    for (const bad of ["../evil", "ws/../x", "a/b", "..\\x"]) {
      await expect(r.register({ id: bad, name: "x", rootPath: "/x" })).rejects.toThrow(/unsafe/);
    }
  });

  test("skips malformed / non-manifest files instead of crashing list()", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "junk.json"), "{not json");
    writeFileSync(join(dir, "missing.json"), JSON.stringify({ id: "x", name: "x" })); // no rootPath
    writeFileSync(join(dir, "note.txt"), "ignored"); // non-json
    const r = repo(dir);
    await r.register({ id: "ws-ok", name: "ok", rootPath: "/ok" });
    expect((await r.list()).map((w) => w.id)).toEqual(["ws-ok"]);
  });

  test("coerces a manifest to the Workspace shape — drops unknown fields", async () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "ws-c.json"),
      JSON.stringify({
        id: "ws-c",
        name: "c",
        rootPath: "/c",
        origin: "git",
        owner: "carlos",
        junk: 1,
      }),
    );
    expect(await repo(dir).get("ws-c")).toEqual({ id: "ws-c", name: "c", rootPath: "/c" });
  });

  test("register is idempotent UPSERT — same id twice → one manifest, updated fields (port contract, P20)", async () => {
    const dir = tmp();
    const r = repo(dir);
    await r.register({ id: "ws-up", name: "v1", rootPath: "/v1" });
    await r.register({ id: "ws-up", name: "v2", rootPath: "/v2" });
    const all = await r.list();
    expect(all.length).toBe(1); // updated, not appended
    expect(all[0]?.name).toBe("v2");
    expect((await r.get("ws-up"))?.rootPath).toBe("/v2");
  });

  test("skips a manifest whose internal id ≠ its filename (get/list can't diverge, P20 Forge)", async () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "filenameX.json"),
      JSON.stringify({ id: "internalY", name: "y", rootPath: "/y" }),
    );
    const r = repo(dir);
    await r.register({ id: "ws-ok", name: "ok", rootPath: "/ok" });
    expect((await r.list()).map((w) => w.id)).toEqual(["ws-ok"]); // filenameX dropped
  });
});
