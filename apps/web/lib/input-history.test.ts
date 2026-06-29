import { describe, expect, test } from "bun:test";
import { recallDirection, recallStep } from "./input-history";

describe("recallDirection — the caret/recall gate (BRO-1598)", () => {
  test("ArrowUp at caret-start ENTERS recall", () => {
    expect(recallDirection("ArrowUp", true, false)).toBe("older");
  });

  test("ArrowUp not-at-start and not recalling passes through (moves caret in a draft)", () => {
    expect(recallDirection("ArrowUp", false, false)).toBeNull();
  });

  // The regression guard: once recalling, ArrowUp must CONTINUE older even though
  // the caret jumped to the end (atStart=false). The old atStart-only gate failed
  // here, degrading multi-step recall to a double-press per step.
  test("ArrowUp while recalling continues regardless of caret (multi-step)", () => {
    expect(recallDirection("ArrowUp", false, true)).toBe("older");
  });

  test("ArrowDown navigates only while recalling", () => {
    expect(recallDirection("ArrowDown", false, true)).toBe("newer");
    expect(recallDirection("ArrowDown", true, false)).toBeNull();
    expect(recallDirection("ArrowDown", false, false)).toBeNull();
  });

  test("other keys never navigate", () => {
    expect(recallDirection("Enter", true, true)).toBeNull();
    expect(recallDirection("a", true, true)).toBeNull();
  });
});

describe("recallStep — composer input-history navigation (BRO-1598)", () => {
  const hist = ["first", "second", "third"]; // oldest → newest

  test("ArrowUp from the live draft recalls the most recent message", () => {
    expect(recallStep(hist, -1, "older")).toEqual({ index: 0, text: "third" });
  });

  test("successive ArrowUp walks backward through history", () => {
    expect(recallStep(hist, 0, "older")).toEqual({ index: 1, text: "second" });
    expect(recallStep(hist, 1, "older")).toEqual({ index: 2, text: "first" });
  });

  test("ArrowUp clamps at the oldest message", () => {
    expect(recallStep(hist, 2, "older")).toEqual({ index: 2, text: "first" });
  });

  test("ArrowDown walks toward the draft", () => {
    expect(recallStep(hist, 2, "newer")).toEqual({ index: 1, text: "second" });
    expect(recallStep(hist, 1, "newer")).toEqual({ index: 0, text: "third" });
  });

  test("ArrowDown off the most recent returns to the empty live draft", () => {
    expect(recallStep(hist, 0, "newer")).toEqual({ index: -1, text: "" });
  });

  test("empty history is a no-op (stays on the draft)", () => {
    expect(recallStep([], -1, "older")).toEqual({ index: -1, text: "" });
    expect(recallStep([], -1, "newer")).toEqual({ index: -1, text: "" });
  });

  test("a single-message history recalls then returns to draft", () => {
    expect(recallStep(["only"], -1, "older")).toEqual({ index: 0, text: "only" });
    expect(recallStep(["only"], 0, "older")).toEqual({ index: 0, text: "only" }); // clamp
    expect(recallStep(["only"], 0, "newer")).toEqual({ index: -1, text: "" });
  });
});
