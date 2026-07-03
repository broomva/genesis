import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "./server";

// The default workspace's DISPLAY NAME is operator-configurable (BRO-1672,
// GENESIS_WORKSPACE_NAME → BuildOpts.workspaceName) so a deploy can label the root
// something meaningful ("root") instead of the "genesis" literal. The id stays
// ws-default (bindings unaffected); only the name changes.

/** Fetch the default workspace's public DTO from a freshly-built app. */
async function defaultWorkspaceName(workspaceName?: string): Promise<string | undefined> {
  const { app } = build({ workspaceRoot: tmpdir(), workspaceName });
  const res = await app.fetch(new Request("http://x/workspaces"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    workspaces: { id: string; name: string }[];
    defaultWorkspace: string;
  };
  return body.workspaces.find((w) => w.id === body.defaultWorkspace)?.name;
}

describe("default workspace name (BRO-1672)", () => {
  test("GENESIS_WORKSPACE_NAME → the default workspace's display name", async () => {
    expect(await defaultWorkspaceName("root")).toBe("root");
  });

  test("unset → falls back to the 'genesis' literal (backward compatible)", async () => {
    expect(await defaultWorkspaceName(undefined)).toBe("genesis");
  });

  test("blank / whitespace-only → falls back to 'genesis' (never an empty label)", async () => {
    expect(await defaultWorkspaceName("   ")).toBe("genesis");
  });

  test("the configured name is trimmed", async () => {
    expect(await defaultWorkspaceName("  root  ")).toBe("root");
  });

  test("the default id is always ws-default regardless of the name", async () => {
    const { app } = build({ workspaceRoot: tmpdir(), workspaceName: "root" });
    const res = await app.fetch(new Request("http://x/workspaces"));
    const body = (await res.json()) as { defaultWorkspace: string };
    expect(body.defaultWorkspace).toBe("ws-default");
  });
});

describe("GET /workspaces/browse route (BRO-1673)", () => {
  const dirs: string[] = [];
  const prevRoots = process.env.GENESIS_WORKSPACE_PATH_ROOTS;
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    if (prevRoots === undefined)
      Reflect.deleteProperty(process.env, "GENESIS_WORKSPACE_PATH_ROOTS");
    else process.env.GENESIS_WORKSPACE_PATH_ROOTS = prevRoots;
  });

  /** A tmp add-root wired via GENESIS_WORKSPACE_PATH_ROOTS (what pathAddRoots() reads). */
  function addRoot(): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "genesis-browse-route-")));
    dirs.push(d);
    process.env.GENESIS_WORKSPACE_PATH_ROOTS = d;
    return d;
  }

  test("lists subdirectories under the add-root", async () => {
    const r = addRoot();
    mkdirSync(join(r, "proj"));
    const { app } = build({ workspaceRoot: tmpdir() });
    const res = await app.fetch(
      new Request(`http://x/workspaces/browse?path=${encodeURIComponent(r)}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; entries: { name: string }[] };
    expect(body.path).toBe(r);
    expect(body.entries.map((e) => e.name)).toEqual(["proj"]);
  });

  test("a path outside the add-roots → a safe 400 (never a 500)", async () => {
    addRoot();
    const { app } = build({ workspaceRoot: tmpdir() });
    const res = await app.fetch(new Request("http://x/workspaces/browse?path=%2Fetc"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("outside the allowed roots");
  });
});
