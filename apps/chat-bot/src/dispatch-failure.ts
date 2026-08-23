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

/** Node/Bun fetch surfaces connection failures as a TypeError whose `cause`
 *  carries the syscall errno. These are the codes that mean "nothing answered". */
const CONNECT_CODES = new Set([
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
  let cur: unknown = e;
  // Walk the cause chain: fetch wraps the real errno one or two levels down.
  for (let depth = 0; cur && depth < 5; depth++) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string") out.push(c);
    const name = (cur as { name?: unknown }).name;
    if (typeof name === "string") out.push(name);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

export function classifyDispatchFailure(e: unknown): DispatchFailure {
  const codes = codesOf(e);
  const msg = e instanceof Error ? e.message : String(e ?? "");

  // AbortError is how both an explicit abort and a fetch timeout arrive.
  if (codes.includes("AbortError") || codes.includes("TimeoutError")) return "timeout";
  if (codes.includes("ETIMEDOUT")) return "timeout";
  if (codes.some((c) => CONNECT_CODES.has(c))) return "backend-unreachable";

  // genesis.ts throws `Genesis /api/chat failed: HTTP <status>` for a non-ok
  // response. Parse the status rather than the prose so a reworded message does
  // not silently reclassify: an unparsed status must fall through, not guess.
  const status = /Genesis \/api\/chat failed: HTTP (\d{3})/.exec(msg)?.[1];
  if (status) {
    const n = Number(status);
    if (n === 401 || n === 403) return "unauthorized";
    return "backend-error";
  }

  // A fetch that could not connect at all, with no errno we recognised.
  if (e instanceof TypeError && /fetch/i.test(msg)) return "backend-unreachable";

  // genesisStream rethrows the agent's own `error` part text. By elimination this
  // is the agent failing rather than the transport, which is the distinction the
  // incident needed and did not have.
  if (e instanceof Error && msg.length > 0) return "agent-error";
  return "unknown";
}

/** The tenant-visible line. Fixed strings only — see the note at the top. */
export function dispatchFailureMessage(kind: DispatchFailure): string {
  switch (kind) {
    case "backend-unreachable":
      return "⚠️ The agent backend is not reachable right now. This is an outage on my side, not something you did — please try again shortly.";
    case "timeout":
      return "⚠️ The agent backend accepted the request but did not respond in time. Please try again shortly.";
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
