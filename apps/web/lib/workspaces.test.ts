import { describe, expect, test } from "bun:test";
import { type Workspace, resolveWorkspace } from "./workspaces";

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
