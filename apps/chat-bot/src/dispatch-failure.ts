// Classify a dispatch failure into something an operator can act on (BRO-2245).
//
// WHY THIS EXISTS — measured, twice, in one incident on 2026-08-23.
//
// The channel posted exactly one string for every failure:
//   "⚠️ Something went wrong handling that — please try again."
//
// During the srv1692698 outage that single string covered two failures with
// completely different fixes, and the operator could not tell them apart from
// WhatsApp:
//   17:09-18:5x  genesis-api was DOWN. The bot's fetch never connected.
//                Fix: restart the api / recover the host.
//   18:5x->      genesis-api was UP and answering. `POST /api/chat` returned 200
//                and emitted {"type":"start"}, then produced nothing for 170s.
//                The agent spawn was wedged. Fix: something else entirely.
//
// Diagnosis took an SSH session that was itself unavailable, and port probes from
// another machine. All of it was already visible at the bot: the first case is a
// connect error, the second is a stream that opens and stalls.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not surface the error's own text.
// The reader may be an untrusted tenant on a shared number, and a raw message can
// carry a path, a hostname, a token fragment, or another tenant's identifier. Each
// branch returns a FIXED string chosen here; nothing from the throw site reaches
// the channel. The full error still goes to the server log, which is where detail
// belongs.

/** Coarse failure classes. Coarse on purpose: each maps to a different operator
 *  action, and a finer split would start encoding internals into a tenant-visible
 *  message. */
export type DispatchFailure =
  | "backend-unreachable"
  | "backend-error"
  | "unauthorized"
  | "timeout"
  | "agent-error"
  | "unknown";

/** Codes that mean "nothing answered".
 *
 *  CAPTURED, NOT ASSUMED. The first version of this file listed only Node errnos
 *  and built its tests from Node-shaped errors — which passed, while misclassifying
 *  the actual runtime. Measured on bun 1.3.14 (darwin), `fetch` to a refused port
 *  AND to a bad hostname both produce:
 *
 *    Error | name=Error | code="ConnectionRefused" | NO cause chain
 *    "Unable to connect. Is the computer able to access the url?"
 *
 *  That is not a TypeError, not "fetch failed", and carries no errno — so the
 *  original list missed the incident's PRIMARY failure entirely. Cross-model review
 *  reported a sibling code (`FailedToOpenSocket`) on its platform, so both are
 *  listed. Node errnos are kept because this module is runtime-agnostic and the
 *  bot may not always run on Bun. Regenerate with scripts/capture-fetch-shapes.ts. */
const CONNECT_CODES = new Set([
  // bun-native
  "ConnectionRefused",
  "FailedToOpenSocket",
  "ConnectionClosed",
  // node errnos
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ECONNRESET",
  "EPIPE",
]);

function codesOf(e: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = e;
  // Walk the cause chain: node wraps the errno a level or two down, bun puts it on
  // the top-level error. `seen` guards a self-referential chain.
  for (let depth = 0; cur && depth < 5 && !seen.has(cur); depth++) {
    seen.add(cur);
    // Property ACCESS is inside the try in classifyDispatchFailure: a hostile or
    // buggy getter must not throw from inside the catch block that calls us.
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string") out.push(c);
    const name = (cur as { name?: unknown }).name;
    if (typeof name === "string") out.push(name);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

/** Marker for "the AGENT reported an error", as opposed to anything else that can
 *  throw inside the dispatch block — `thread.post`, stream consumption, a parser.
 *  Without a marker every unmatched Error was called `agent-error`, which
 *  misdiagnosed channel failures as agent failures. Attribution now requires
 *  positive evidence; everything else falls to `unknown`. */
export class AgentReportedError extends Error {
  readonly isAgentReported = true;
}

function isAgentReported(e: unknown): boolean {
  return (
    e instanceof AgentReportedError ||
    (e as { isAgentReported?: unknown })?.isAgentReported === true
  );
}

export function classifyDispatchFailure(e: unknown): DispatchFailure {
  try {
    return classify(e);
  } catch {
    // Total by construction. This runs INSIDE a catch block on the dispatch path;
    // a hostile `toString`/getter making the classifier itself throw would turn a
    // handled failure into an unhandled one and post nothing at all.
    return "unknown";
  }
}

function classify(e: unknown): DispatchFailure {
  const codes = codesOf(e);
  const msg = e instanceof Error ? e.message : String(e ?? "");

  // AbortError is how both an explicit abort and a fetch timeout arrive.
  if (codes.includes("AbortError") || codes.includes("TimeoutError")) return "timeout";
  if (codes.includes("ETIMEDOUT")) return "timeout";
  if (codes.some((c) => CONNECT_CODES.has(c))) return "backend-unreachable";

  // genesis.ts throws `Genesis /api/chat failed: HTTP <status>` for a non-ok
  // response. Parse the status rather than the prose so a reworded message does
  // not silently reclassify: an unparsed status must fall through, not guess.
  // ANCHORED: an agent's own error text containing this phrase must not be read as
  // a transport status. genesis.ts throws it as the whole message, so anchoring
  // costs nothing and closes the confusion.
  const status = /^Genesis \/api\/chat failed: HTTP (\d{3})$/.exec(msg)?.[1];
  if (status) {
    const n = Number(status);
    if (n === 401 || n === 403) return "unauthorized";
    return "backend-error";
  }

  // A fetch that could not connect at all, with no code we recognised.
  if (e instanceof TypeError && /fetch/i.test(msg)) return "backend-unreachable";
  // bun's connect failure carries no errno and no cause — match its wording as a
  // last resort, so a future code rename degrades to unreachable rather than to a
  // misattributed agent failure.
  if (/unable to connect/i.test(msg)) return "backend-unreachable";

  // POSITIVE attribution only. Everything unmatched — a thread.post failure, a
  // parser bug, a stream consumer error — is `unknown`, not the agent's fault.
  if (isAgentReported(e)) return "agent-error";
  return "unknown";
}

/** The tenant-visible line. Fixed strings only — see the note at the top. */
export function dispatchFailureMessage(kind: DispatchFailure): string {
  switch (kind) {
    case "backend-unreachable":
      return "⚠️ The agent backend is not reachable right now. This is an outage on my side, not something you did — please try again shortly.";
    case "timeout":
      return "⚠️ The agent backend did not respond in time. This is an outage on my side — please try again shortly.";
    case "unauthorized":
      return "⚠️ This channel is not authorised to reach the agent backend. That needs an operator to fix; retrying will not help.";
    case "backend-error":
      return "⚠️ The agent backend returned an error. This is an outage on my side — please try again shortly.";
    case "agent-error":
      return "⚠️ The agent failed while handling that. Please try again, and rephrase if it keeps happening.";
    default:
      return "⚠️ Something went wrong handling that — please try again.";
  }
}
