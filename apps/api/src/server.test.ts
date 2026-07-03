import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
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
