// Projection reducer — the make-or-break piece of Genesis Phase 1.
// Folds the parsed NDJSON AgentEvent stream into a single run-phase state
// machine the chat layer renders: running | awaiting | blocked | done.
import { sessionIdOf, textBlocks, toolUses } from "./parser";
export const initialState = { phase: "running", turns: 0 };
/** Tool names that pause the run for human input (Phase 3 HITL seam). */
const AWAIT_TOOLS = new Set(["AskUserQuestion", "ask_user_question"]);
function extractQuestion(input) {
    if (typeof input !== "object" || input === null)
        return undefined;
    const qs = input.questions;
    if (Array.isArray(qs) && qs.length > 0) {
        const first = qs[0];
        if (first &&
            typeof first === "object" &&
            typeof first.question === "string") {
            return first.question;
        }
    }
    return undefined;
}
/** Apply one event to the run state. Pure; safe to replay. */
export function reduce(state, event) {
    const sessionId = sessionIdOf(event) ?? state.sessionId;
    switch (event.type) {
        case "system":
            return { ...state, sessionId, phase: "running" };
        case "assistant": {
            const texts = textBlocks(event.message);
            const lastText = texts.length > 0 ? texts[texts.length - 1] : state.lastText;
            const awaiting = toolUses(event.message).find((t) => AWAIT_TOOLS.has(t.name));
            if (awaiting) {
                return {
                    ...state,
                    sessionId,
                    phase: "awaiting",
                    lastText,
                    turns: state.turns + 1,
                    pendingQuestion: extractQuestion(awaiting.input) ?? lastText,
                };
            }
            return { ...state, sessionId, phase: "running", lastText, turns: state.turns + 1 };
        }
        case "user":
            // A tool_result returned — the agent resumes; clear any awaiting gate.
            return { ...state, sessionId, phase: "running", pendingQuestion: undefined };
        case "result": {
            const errored = event.is_error === true || (event.subtype !== undefined && event.subtype !== "success");
            if (errored) {
                return { ...state, sessionId, phase: "blocked", error: event.subtype ?? "error" };
            }
            return { ...state, sessionId, phase: "done", lastText: event.result ?? state.lastText };
        }
        default:
            return state;
    }
}
/** Fold a whole event stream from the initial state. */
export function reduceAll(events, from = initialState) {
    return events.reduce(reduce, from);
}
