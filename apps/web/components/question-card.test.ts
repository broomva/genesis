import { describe, expect, test } from "bun:test";
import { type Question, asQuestions, combineAnswers } from "./question-card";

describe("asQuestions (BRO-1611)", () => {
  test("parses well-formed questions", () => {
    const qs = asQuestions({
      questions: [{ question: "Target?", header: "Deploy", options: [{ label: "Railway" }] }],
    });
    expect(qs).toHaveLength(1);
    expect(qs[0].question).toBe("Target?");
  });
  test("defensive: null / non-object / missing array / bad entries → []", () => {
    expect(asQuestions(null)).toEqual([]);
    expect(asQuestions("x")).toEqual([]);
    expect(asQuestions({})).toEqual([]);
    expect(asQuestions({ questions: "no" })).toEqual([]);
    expect(asQuestions({ questions: [{ noQuestion: 1 }, 5, null] })).toEqual([]);
  });
});

describe("combineAnswers (BRO-1611 multi-question fix)", () => {
  const q = (question: string, header?: string): Question => ({ question, header });

  test("single question → just the answer (one-tap case)", () => {
    expect(combineAnswers([q("Target?")], { 0: ["Railway"] })).toBe("Railway");
  });
  test("multi question → labelled lines so the mapping is unambiguous", () => {
    const qs = [q("Target?", "Deploy"), q("Region?", "Region")];
    expect(combineAnswers(qs, { 0: ["Railway"], 1: ["us-east-1"] })).toBe(
      "Deploy: Railway\nRegion: us-east-1",
    );
  });
  test("multi-select answers join within a question", () => {
    const qs = [q("Pick features", "Features")];
    // single question path joins the multi-select labels
    expect(combineAnswers(qs, { 0: ["A", "B"] })).toBe("A, B");
  });
  test("falls back to the question text when no header", () => {
    const qs = [q("Q1?"), q("Q2?")];
    expect(combineAnswers(qs, { 0: ["a"], 1: ["b"] })).toBe("Q1?: a\nQ2?: b");
  });
});
