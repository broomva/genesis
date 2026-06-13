import { describe, expect, test } from "bun:test";
import { resolveClaudeBinary } from "../src/session";

describe("resolveClaudeBinary", () => {
  test("explicit bin wins over everything", () => {
    expect(resolveClaudeBinary("2.1.173", "/custom/claude")).toBe("/custom/claude");
  });

  test("no pin → PATH claude", () => {
    expect(resolveClaudeBinary()).toBe("claude");
  });

  test("a missing pin falls back to PATH claude, not a throw (BRO-1494 pin-rot)", () => {
    // The auto-updater prunes old versions; a vanished pin must degrade, not
    // hard-fail every turn.
    expect(resolveClaudeBinary("0.0.0-does-not-exist")).toBe("claude");
  });
});
