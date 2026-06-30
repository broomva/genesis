import { describe, expect, test } from "bun:test";
import { humanizeSkill } from "./tool";

describe("humanizeSkill (BRO-1625)", () => {
  test("title-cases a single bare slug", () => {
    expect(humanizeSkill("kg")).toBe("Kg");
    expect(humanizeSkill("autonomous")).toBe("Autonomous");
  });

  test("splits kebab/snake/space into title-cased words", () => {
    expect(humanizeSkill("knowledge-graph-memory")).toBe("Knowledge Graph Memory");
    expect(humanizeSkill("cross_review")).toBe("Cross Review");
    expect(humanizeSkill("make spec")).toBe("Make Spec");
  });

  test("drops a plugin namespace, keeping the skill's own name", () => {
    expect(humanizeSkill("broomva:bookkeeping")).toBe("Bookkeeping");
    expect(humanizeSkill("superpowers:constructive-dissent")).toBe("Constructive Dissent");
  });

  test("collapses repeated/edge separators without empty words", () => {
    expect(humanizeSkill("p9--watch")).toBe("P9 Watch");
    expect(humanizeSkill("_leading_trailing_")).toBe("Leading Trailing");
  });

  test("falls back to the trimmed raw slug when nothing tokenizes", () => {
    expect(humanizeSkill("   ")).toBe("");
    expect(humanizeSkill("::")).toBe("::");
  });
});
