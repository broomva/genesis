import { describe, expect, test } from "bun:test";
import { tenantEnv } from "./supervisor";

// BRO-2235. The point of these is the DEFAULT case: an unset `home` must leave the
// environment exactly as it was, because this is fail-SAFE, not fail-closed. A
// tenant whose home was never provisioned must keep working, not lose its
// credential and fail every turn.
describe("tenantEnv", () => {
  test("unset home → base returned untouched (current behaviour preserved)", () => {
    expect(tenantEnv({})).toBeUndefined();
    expect(tenantEnv({}, { A: "1" })).toEqual({ A: "1" });
  });

  test.each([[""], ["   "]])("blank home %p is treated as unset", (h) => {
    expect(tenantEnv({ home: h }, { A: "1" })).toEqual({ A: "1" });
  });

  test("absolute home sets HOME", () => {
    expect(tenantEnv({ home: "/t/573/home" })).toEqual({ HOME: "/t/573/home" });
  });

  test("merges over a base without dropping it", () => {
    expect(tenantEnv({ home: "/t/h" }, { A: "1" })).toEqual({ A: "1", HOME: "/t/h" });
  });

  // A relative HOME resolves against the CHILD'S CWD — the tenant's own workspace —
  // so `.claude` would land somewhere the tenant can write, handing it its own
  // settings file. That is the opposite of the isolation this exists for.
  test.each([["home"], ["./home"], ["../escape"], ["t/home"]])(
    "relative home %p is REFUSED, falling back to base",
    (h) => {
      expect(tenantEnv({ home: h }, { A: "1" })).toEqual({ A: "1" });
    },
  );

  test("HOME wins over a base that already set it", () => {
    expect(tenantEnv({ home: "/t/h" }, { HOME: "/home/agent" })).toEqual({ HOME: "/t/h" });
  });
});
