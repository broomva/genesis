import { afterEach, describe, expect, test } from "bun:test";
import {
  type Workspace,
  addWorkspace,
  fetchAvailableWorkspaces,
  fetchWorkspaces,
  removeWorkspace,
  resolveWorkspace,
} from "./workspaces";

const origFetch = global.fetch;
afterEach(() => {
  global.fetch = origFetch;
});

/** Stub global.fetch with a single canned Response-like value. */
function stubFetch(ok: boolean, body: unknown, opts?: { throws?: boolean }): void {
  global.fetch = (async () => {
    if (opts?.throws) throw new Error("network down");
    return { ok, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

const list: Workspace[] = [
  { id: "ws-1", name: "default" },
  { id: "ws-a", name: "alpha" },
  { id: "ws-b", name: "beta" },
];

describe("resolveWorkspace (BRO-1627)", () => {
  test("empty list → '' (the picker is hidden then anyway)", () => {
    expect(resolveWorkspace("ws-a", "ws-b", "ws-1", [])).toBe("");
  });

  test("the thread's bound id wins when it's in the list", () => {
    expect(resolveWorkspace("ws-b", "ws-a", "ws-1", list)).toBe("ws-b");
  });

  test("a stale bound id falls to the pref", () => {
    expect(resolveWorkspace("ws-gone", "ws-a", "ws-1", list)).toBe("ws-a");
  });

  test("stale bound + stale pref falls to the server default", () => {
    expect(resolveWorkspace("ws-gone", "ws-also-gone", "ws-1", list)).toBe("ws-1");
  });

  test("all stale → the first list member (never '' for a non-empty list, so Radix never gets value='')", () => {
    expect(resolveWorkspace("x", "y", "z", list)).toBe("ws-1");
  });

  test("undefined bound + empty pref → the server default", () => {
    expect(resolveWorkspace(undefined, "", "ws-b", list)).toBe("ws-b");
  });
});

describe("fetchAvailableWorkspaces (BRO-1629 slice 3)", () => {
  test("returns well-formed repos, drops malformed items", async () => {
    stubFetch(true, {
      available: [
        { id: "ws-a", name: "alpha" },
        { id: "", name: "empty-id" }, // dropped — Radix/empty-id hazard
        { id: "ws-blank", name: "" }, // dropped — blank name → blank Add btn + POST {pick:""} (N2)
        { name: "no-id" }, // dropped
        "junk", // dropped
      ],
    });
    expect(await fetchAvailableWorkspaces()).toEqual([{ id: "ws-a", name: "alpha" }]);
  });

  test("non-ok response → [] (add affordance shows nothing)", async () => {
    stubFetch(false, { error: "unauthorized" });
    expect(await fetchAvailableWorkspaces()).toEqual([]);
  });

  test("thrown fetch → []", async () => {
    stubFetch(true, {}, { throws: true });
    expect(await fetchAvailableWorkspaces()).toEqual([]);
  });
});

describe("fetchWorkspaces — availability passthrough (BRO-1630 RC3)", () => {
  test("preserves `available` when the engine reports it", async () => {
    stubFetch(true, {
      workspaces: [
        { id: "ws-1", name: "default", available: true },
        { id: "ws-gone", name: "ghost", available: false },
        { id: "ws-old", name: "legacy" }, // older engine omits it
      ],
      defaultWorkspace: "ws-1",
    });
    const { workspaces } = await fetchWorkspaces();
    expect(workspaces.find((w) => w.id === "ws-1")?.available).toBe(true);
    expect(workspaces.find((w) => w.id === "ws-gone")?.available).toBe(false);
    // Omitted by an older engine → undefined (the UI treats it as available).
    expect(workspaces.find((w) => w.id === "ws-old")?.available).toBeUndefined();
  });

  test("still drops malformed items (empty id) while carrying availability", async () => {
    stubFetch(true, {
      workspaces: [
        { id: "", name: "bad", available: false },
        { id: "ws-ok", name: "ok", available: false },
      ],
      defaultWorkspace: "ws-ok",
    });
    const { workspaces } = await fetchWorkspaces();
    expect(workspaces).toEqual([{ id: "ws-ok", name: "ok", available: false }]);
  });
});

describe("addWorkspace (BRO-1629 slice 3)", () => {
  test("ok → the new workspace (isGitRepo preserved)", async () => {
    stubFetch(true, { id: "ws-x", name: "x", isGitRepo: true });
    expect(await addWorkspace("x")).toEqual({
      ok: true,
      workspace: { id: "ws-x", name: "x", isGitRepo: true },
    });
  });

  test("400 → the engine's safe error message is surfaced verbatim", async () => {
    stubFetch(false, { error: "invalid pick (must be a plain directory name)" });
    expect(await addWorkspace("../etc")).toEqual({
      ok: false,
      error: "invalid pick (must be a plain directory name)",
    });
  });

  test("ok but a malformed body (no id) → a generic failure, not a broken workspace", async () => {
    stubFetch(true, { name: "x" });
    const res = await addWorkspace("x");
    expect(res.ok).toBe(false);
  });

  test("ok but an EMPTY id/name → rejected (upholds the non-empty invariant, CodeRabbit)", async () => {
    stubFetch(true, { id: "", name: "x" });
    expect((await addWorkspace("x")).ok).toBe(false);
    stubFetch(true, { id: "ws-x", name: "" });
    expect((await addWorkspace("x")).ok).toBe(false);
  });

  test("thrown fetch → a network-error result", async () => {
    stubFetch(true, {}, { throws: true });
    const res = await addWorkspace("x");
    expect(res.ok).toBe(false);
  });
});

describe("removeWorkspace (BRO-1629 slice 3)", () => {
  test("ok → true", async () => {
    stubFetch(true, {});
    expect(await removeWorkspace("ws-x")).toBe(true);
  });

  test("non-ok (e.g. default id protected) → false", async () => {
    stubFetch(false, { error: "the default workspace cannot be removed" });
    expect(await removeWorkspace("ws-default")).toBe(false);
  });

  test("thrown fetch → false", async () => {
    stubFetch(true, {}, { throws: true });
    expect(await removeWorkspace("ws-x")).toBe(false);
  });
});
