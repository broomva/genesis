import { describe, expect, test } from "bun:test";
import { recallStep } from "./input-history";

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
