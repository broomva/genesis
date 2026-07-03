import { describe, expect, test } from "bun:test";
import { classifyGhError, parseRunsJson } from "./workspace-checks";

describe("parseRunsJson (BRO-1669)", () => {
  test("parses gh run list --json output into clean runs", () => {
    const json = JSON.stringify([
      {
        databaseId: 123,
        displayTitle: "feat: a thing",
        status: "completed",
        conclusion: "success",
        workflowName: "test",
        createdAt: "2026-07-03T00:00:00Z",
        url: "https://github.com/o/r/actions/runs/123",
      },
      {
        databaseId: 124,
        displayTitle: "wip",
        status: "in_progress",
        conclusion: "", // running → null
        workflowName: "test",
        createdAt: "2026-07-03T01:00:00Z",
        url: "https://github.com/o/r/actions/runs/124",
      },
    ]);
    const runs = parseRunsJson(json);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual({
      id: 123,
      title: "feat: a thing",
      workflow: "test",
      status: "completed",
      conclusion: "success",
      url: "https://github.com/o/r/actions/runs/123",
      createdAt: "2026-07-03T00:00:00Z",
    });
    expect(runs[1]?.conclusion).toBeNull(); // empty conclusion → null
  });

  test("is defensive against malformed / garbage input", () => {
    expect(parseRunsJson("not json")).toEqual([]);
    expect(parseRunsJson("{}")).toEqual([]); // not an array
    expect(parseRunsJson('[null, "x", 3]')).toEqual([]); // no valid objects
    const coerced = parseRunsJson('[{"databaseId":"nope","displayTitle":5}]');
    expect(coerced[0]).toEqual({
      id: 0,
      title: "",
      workflow: "",
      status: "",
      conclusion: null,
      url: "",
      createdAt: "",
    });
  });
});

describe("classifyGhError (BRO-1669)", () => {
  const err = (over: { code?: unknown; stderr?: string }) => over;
  test("maps a missing gh binary (string code) to a safe reason", () => {
    expect(classifyGhError(err({ code: "ENOENT" }))).toMatch(/not installed/i);
  });
  test("maps an auth failure", () => {
    expect(
      classifyGhError(
        err({ code: 1, stderr: "To get started with GitHub CLI, please run: gh auth login" }),
      ),
    ).toMatch(/not authenticated/i);
  });
  test("maps a non-GitHub repo", () => {
    expect(
      classifyGhError(
        err({
          code: 1,
          stderr:
            "none of the git remotes configured for this repository point to a known GitHub host",
        }),
      ),
    ).toMatch(/isn't a GitHub repository/i);
  });
  test("falls back to a generic reason", () => {
    expect(classifyGhError(err({ code: 1, stderr: "some other network blip" }))).toMatch(
      /couldn't reach GitHub/i,
    );
  });
});
