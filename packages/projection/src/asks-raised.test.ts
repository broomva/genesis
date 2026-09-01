// `asksRaisedBy` — the pure half of the ask producer (BRO-2413).
//
// Separated from the end-to-end suite deliberately: this is parsing of agent
// output, so its inputs are hostile by nature, and the cases that matter are the
// malformed ones a live-agent test would never generate.

import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "./parser";
import { asksRaisedBy } from "./reducer";

const assistant = (blocks: unknown[]): AgentEvent =>
  ({ type: "assistant", message: { content: blocks } }) as unknown as AgentEvent;

const ask = (id: unknown, questions: unknown, name = "AskUserQuestion") => ({
  type: "tool_use",
  id,
  name,
  input: { questions },
});

describe("asksRaisedBy", () => {
  test("extracts the tool_use id as the ask's identity", () => {
    const [a] = asksRaisedBy(assistant([ask("toolu_9", [{ question: "Ship?" }])]));
    expect(a?.toolUseId).toBe("toolu_9");
    expect(a?.question).toBe("Ship?");
  });

  test("RE-PARSING the same event yields the same ids", () => {
    // The property that makes the append-only store idempotent under replay: the
    // id comes from the SDK, not from a counter or a clock. If this drifts, a
    // re-parsed event becomes a second ask the operator must answer twice.
    const e = assistant([ask("toolu_9", [{ question: "A?" }, { question: "B?" }])]);
    expect(asksRaisedBy(e).map((a) => a.toolUseId)).toEqual(
      asksRaisedBy(e).map((a) => a.toolUseId),
    );
  });

  test("several questions in one call get DISTINCT ids", () => {
    const ids = asksRaisedBy(
      assistant([ask("toolu_9", [{ question: "A?" }, { question: "B?" }])]),
    ).map((a) => a.toolUseId);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((i) => i.startsWith("toolu_9"))).toBe(true);
  });

  test("a SINGLE question keeps the bare tool_use id, unsuffixed", () => {
    // The common case must not carry a "#0" the answer would have to reproduce.
    expect(asksRaisedBy(assistant([ask("toolu_9", [{ question: "A?" }])]))[0]?.toolUseId).toBe(
      "toolu_9",
    );
  });

  test("a tool_use with NO id raises nothing", () => {
    // An ask an answer cannot refer to would sit in the operator's list
    // permanently unanswerable. This is also the case that nearly shipped
    // silently: `toolUses` dropped the id, the producer read it through a cast,
    // and every ask was skipped with tsc satisfied.
    expect(asksRaisedBy(assistant([ask(undefined, [{ question: "Ship?" }])]))).toEqual([]);
    expect(asksRaisedBy(assistant([ask(42, [{ question: "Ship?" }])]))).toEqual([]);
  });

  test("a non-await tool raises nothing", () => {
    expect(asksRaisedBy(assistant([ask("toolu_9", [{ question: "Q?" }], "Bash")]))).toEqual([]);
  });

  test("the snake_case tool name is recognised too", () => {
    // AWAIT_TOOLS carries both spellings; a producer that honoured only one would
    // silently drop every ask from whichever engine uses the other.
    expect(
      asksRaisedBy(assistant([ask("toolu_9", [{ question: "Q?" }], "ask_user_question")])),
    ).toHaveLength(1);
  });

  test("a non-assistant event raises nothing", () => {
    expect(asksRaisedBy({ type: "result", subtype: "success" } as AgentEvent)).toEqual([]);
  });

  test("malformed questions are dropped, well-formed siblings survive", () => {
    const out = asksRaisedBy(
      assistant([
        ask("toolu_9", [null, { question: "" }, { question: 42 }, { question: "Real?" }]),
      ]),
    );
    expect(out.map((a) => a.question)).toEqual(["Real?"]);
  });

  test("options are validated elementwise, not cast", () => {
    const [a] = asksRaisedBy(
      assistant([
        ask("toolu_9", [
          {
            question: "Q?",
            options: [1, null, { label: {} }, { label: "ok" }, { label: "d", description: "why" }],
          },
        ]),
      ]),
    );
    expect(a?.options).toEqual([{ label: "ok" }, { label: "d", description: "why" }]);
  });

  test("absent optional fields are ABSENT, not undefined-valued", () => {
    // They are JSON.stringify'd into an append-only journal; an explicit
    // `"header":null` is a different record from one without the key.
    const [a] = asksRaisedBy(assistant([ask("toolu_9", [{ question: "Q?" }])]));
    expect(Object.hasOwn(a ?? {}, "header")).toBe(false);
    expect(Object.hasOwn(a ?? {}, "options")).toBe(false);
    expect(Object.hasOwn(a ?? {}, "multiSelect")).toBe(false);
  });
});
