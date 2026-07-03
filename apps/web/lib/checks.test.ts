import { describe, expect, test } from "bun:test";
import { type CheckRunData, normalizeChecks, runState } from "./checks";

describe("normalizeChecks (BRO-1669)", () => {
  test("passes a clean checks body through", () => {
    const out = normalizeChecks({
      available: true,
      repo: "broomva/genesis",
      branch: "main",
      runs: [
        {
          id: 1,
          title: "feat: x",
          workflow: "test",
          status: "completed",
          conclusion: "success",
          url: "https://u/1",
          createdAt: "2026-07-03T00:00:00Z",
        },
      ],
    });
    expect(out.available).toBe(true);
    expect(out.repo).toBe("broomva/genesis");
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]?.conclusion).toBe("success");
  });

  test("defaults available:false + drops malformed runs", () => {
    const out = normalizeChecks({ runs: [null, 3, { id: 2, title: "ok" }] });
    expect(out.available).toBe(false);
    expect(out.runs).toEqual([
      { id: 2, title: "ok", workflow: "", status: "", conclusion: null, url: "", createdAt: "" },
    ]);
  });

  test("tolerates an empty/garbage body + preserves reason", () => {
    expect(normalizeChecks(undefined)).toEqual({
      available: false,
      repo: undefined,
      branch: undefined,
      runs: [],
      reason: undefined,
    });
    expect(normalizeChecks({ available: false, reason: "not a GitHub repo" }).reason).toBe(
      "not a GitHub repo",
    );
  });
});

describe("runState (BRO-1669)", () => {
  const r = (over: Partial<CheckRunData>): CheckRunData => ({
    id: 1,
    title: "",
    workflow: "",
    status: "completed",
    conclusion: "success",
    url: "",
    createdAt: "",
    ...over,
  });
  test("folds status + conclusion into a badge state", () => {
    expect(runState(r({ status: "completed", conclusion: "success" }))).toBe("success");
    expect(runState(r({ status: "completed", conclusion: "failure" }))).toBe("failure");
    expect(runState(r({ status: "completed", conclusion: "timed_out" }))).toBe("failure");
    expect(runState(r({ status: "completed", conclusion: "cancelled" }))).toBe("neutral");
    expect(runState(r({ status: "in_progress", conclusion: null }))).toBe("running");
    expect(runState(r({ status: "queued", conclusion: null }))).toBe("pending");
  });
});
