// The ask log (BRO-2387) — the one durable object walkie genuinely owns.
//
// WHY THIS FILE EXISTS. Genesis has no ask log. `pendingQuestion`
// (packages/projection/src/reducer.ts:210) is projection state: absent from every
// table, cleared on tool result, and — verified — with zero production readers. It
// is a view, not a record. Nothing in Genesis can tell you what an agent is
// currently blocked on across a restart.
//
// NOTHING WRITES AN ASK YET, and that has to be said here rather than discovered.
// `append` has zero non-test callers: no engine hook, no supervisor callback, no
// tool-call interception produces an Ask. So in a real deploy asks.jsonl stays
// empty, GET /walkie/asks returns {"asks":[]} forever and POST /walkie/answer
// 404s forever. The store, the routes and their gate are real and tested; the
// PRODUCER is not built.
//
// That is the ticket's scope — step 1 is the durable object and its two verbs,
// and the engine integration comes later — but a surface that answers 200 while
// being permanently empty reads as "working" to anyone who does not know, and
// the boot log line saying where the ask log lives reinforces that. The gap is
// named here, in the PR, and in the ticket rather than left for the first person
// who wonders why the list is always empty. (P20 MAJOR.)
//
// NOT queue.jsonl. That file holds VoiceTicket: caller-originated intake, keyed by
// an explicitly untrusted phone number. An ask is agent-originated and keyed by
// session and thread. Writing agent-originated asks into a caller-id-keyed intake
// file is the failure AGENTS.md:181-185 forbids by name, so these are separate
// stores in separate files and a test asserts an ask never lands in the queue.
//
// SHAPE BORROWED FROM voice-queue.ts, DELIBERATELY. Two append-only JSONL files
// joined at read time — asks.jsonl is the record, answers.jsonl is what became of
// each. That is exactly readQueueStatus's queue/delivered join, and it is worth
// copying for a reason beyond familiarity: the join gives idempotency for free.
// `answers` is a Map keyed by ask id, so answering the same ask twice overwrites
// rather than double-counts. The write path stays append-only and dumb; the read
// path is where "acking twice is a no-op" actually lives.
//
// DURABILITY IS NOT BEST-EFFORT HERE, and that is the one place this deliberately
// departs from voice-queue.ts. That file's comment (voice-queue.ts:61-71) states
// the rule: "The change that adds a queue-draining consumer — the moment a caller
// is told an answer IS coming — is the change that must add an fsync or a real
// queue." An ask is precisely that: someone is told a question is pending and an
// answer is expected back. So every append here fsyncs.
//
// The cost argument that makes fsync contentious for the voice queue does not
// apply. /voice/request runs with a caller on the line, so an fsync sits in a
// human-perceptible hot path. An ask is written by an agent mid-turn, inside a
// 9-30s round trip, where a page-cache flush is noise. Same rule, different
// price.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Where asks land. Append-only JSONL, one ask per line. */
export const ASK_FILE = "asks.jsonl";

/** What became of each ask. Append-only; latest entry per id wins at read time. */
export const ANSWER_FILE = "answers.jsonl";

/** One option offered by an AskUserQuestion invocation. */
export interface AskOption {
  readonly label: string;
  readonly description?: string;
}

/** An agent, mid-run, blocked on a decision only a person can make. */
export interface Ask {
  /** Stable across retries of the same tool call — the id the answer refers to. */
  readonly id: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly question: string;
  readonly header?: string;
  readonly options?: readonly AskOption[];
  readonly multiSelect?: boolean;
  readonly createdAt: string;
}

/** The decision coming back. */
export interface AskAnswer {
  readonly id: string;
  readonly answer: string;
  readonly answeredAt: string;
}

export type AskStatus = "pending" | "answered";

/** An ask joined with what became of it. */
export interface AskEntry extends Ask {
  /** The id appears under more than one threadId, so no answer can be attached to
   *  it without guessing which ask a decision belonged to. Present ONLY when
   *  true, so a client can disable its answer control and say why, rather than
   *  discovering it as a 409 after the operator has already decided. */
  readonly ambiguous?: true;
  readonly status: AskStatus;
  readonly answer?: string;
  readonly answeredAt?: string;
}

/** Append one JSON line and flush it to the platter before returning.
 *
 *  openSync/writeSync/fsyncSync/closeSync rather than appendFileSync, because
 *  appendFileSync returns once the bytes reach the page cache — which is the exact
 *  gap voice-queue.ts:61-71 documents and this file exists on the other side of.
 *  The fd is opened per append rather than held for the process lifetime: holding
 *  it would make this module stateful, and a stale fd across a log rotation fails
 *  silently by writing into an unlinked inode.
 *
 *  No try/catch. Failure policy is voice-queue.ts's, for the same reason: a
 *  dropped ask is a question the operator was told was pending and which then
 *  vanished. The throw becomes the route's 503. */
export interface DurableFs {
  openSync(path: string, flags: string): number;
  writeSync(fd: number, s: string): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
}

/** The production ops. Exported ONLY so a test can assert these are the real
 *  node:fs syscalls rather than lookalikes — the injected seam cannot see this. */
export const REAL_FS: DurableFs = { openSync, writeSync, fsyncSync, closeSync };

function durableAppend(file: string, record: unknown, fs: DurableFs): void {
  const line = `${JSON.stringify(record)}\n`;
  const fd = fs.openSync(file, "a");
  try {
    // writeSync RETURNS A COUNT and POSIX write() is permitted to write fewer
    // bytes than asked — the ordinary shape of a nearly-full filesystem, where
    // it writes what fits and returns short rather than raising ENOSPC.
    //
    // Discarding that count does not merely lose the record. The partial line
    // has no trailing newline, so the NEXT append's bytes land on it and the two
    // records are glued into one unparseable line — the reader skips it and BOTH
    // are gone, silently, with the caller having been told both were recorded.
    // (P20 BLOCKER, reproduced under RLIMIT_FSIZE: writeSync returned 1024 for a
    // 2031-byte record and did not throw.)
    let written = 0;
    while (written < line.length) {
      const n = fs.writeSync(fd, line.slice(written));
      // A zero-byte write makes no progress; looping would spin forever.
      if (n <= 0)
        throw new Error(`short write to ${file}: wrote ${written} of ${line.length} bytes`);
      written += n;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** The write half. Directory created ONCE at construction, never per append —
 *  voice-queue.ts:93-95's reason applies unchanged. */
export function createAskLog(
  dir: string,
  /** Injectable ONLY so a test can observe the syscall sequence. Defaults to the
   *  real thing; production never passes this.
   *
   *  The alternative was `mock.module("node:fs")`, and it does not work here:
   *  `bun test` runs every file in ONE process, so a module mock leaks into every
   *  file loaded after it. That took the full suite from 0 to 126 failures, and
   *  the two-file check written to prove isolation passed vacuously — two files
   *  is a favourable ordering. */
  fs: DurableFs = REAL_FS,
): {
  append(ask: Ask): void;
  answer(answer: AskAnswer): void;
} {
  mkdirSync(dir, { recursive: true });
  const askPath = join(dir, ASK_FILE);
  const answerPath = join(dir, ANSWER_FILE);
  return {
    append: (ask: Ask) => durableAppend(askPath, ask, fs),
    answer: (answer: AskAnswer) => durableAppend(answerPath, answer, fs),
  };
}

interface RawAnswer {
  id: string;
  answer: string;
  answeredAt?: string;
}

function isAnswer(v: unknown): v is RawAnswer {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  // answeredAt included: it was the ONE unchecked field here, so `answeredAt:
  // 12345` round-tripped as a number under a declared `answeredAt?: string`.
  // Every other field on the ask side is guarded three lines away. (P20 MAJOR.)
  return (
    typeof e.id === "string" &&
    e.id.length > 0 &&
    // NON-EMPTY. POST /walkie/answer already refuses an empty answer with
    // "answer must be a non-empty string", so a reader that accepts one lets the
    // two halves disagree about what a decision is — and an empty answer read
    // back marks the ask ANSWERED, hiding it from the pending list and locking
    // every later attempt into a 409 that names an empty standing decision.
    typeof e.answer === "string" &&
    e.answer.length > 0 &&
    (e.answeredAt === undefined || typeof e.answeredAt === "string")
  );
}

/** Read a JSONL file, tolerantly.
 *
 *  Reads FIRST rather than existsSync-then-read: existsSync answers false for a
 *  path it cannot stat — an unreadable parent directory, say — so gating on it
 *  turns "I am not allowed to look" into "there is nothing here". That is the
 *  silent lie `degraded` exists to prevent, and the reasoning is voice-queue.ts's
 *  (:159-163) rather than mine.
 *
 *  ENOENT is the only healthy absence. The message names the FILE and never the
 *  path, because it reaches a browser and the absolute location is not the
 *  client's business. */
function readLines(dir: string, name: string, onDegraded: (msg: string) => void): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, name), "utf8");
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "ENOENT") return [];
    onDegraded(`${name} could not be read (${code ?? "unknown error"})`);
    return [];
  }
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // A torn final line is expected while another process appends. Skipped,
      // never fatal — same tolerance as parseQueue.
    }
  }
  return out;
}

/** Join asks.jsonl with answers.jsonl. Oldest first: an operator working through
 *  a backlog answers the longest-waiting question first, which is the opposite of
 *  readQueueStatus's "what just happened" ordering and deliberately so.
 *
 *  Idempotency lives here. `answers` is a Map, so a repeated answer for one id
 *  overwrites instead of appending an effect — which is what makes acking twice a
 *  no-op without the write path needing to know anything. Duplicate ASKS collapse
 *  the same way: a retried tool call yields a stable id, and the ask is shown once.
 *
 *  `threadId` is a FILTER, not an authorization boundary, and the distinction
 *  matters: the thread is chosen by the caller as a query parameter, so anyone
 *  holding the shared secret can read any thread. An earlier version of this
 *  comment said the reader "is scoped to their own thread", which described a
 *  property nothing implements. There is no principal partition anywhere in this
 *  repo; inventing one here would be a second answer to a question the codebase
 *  has already answered differently, and pretending one exists is worse than
 *  either. (P20 MINOR.) */
export function readAsks(
  dir: string,
  opts?: { threadId?: string; includeAnswered?: boolean },
): {
  entries: AskEntry[];
  degraded?: string;
  unreadable?: true;
  ambiguous?: ReadonlySet<string>;
} {
  // ACCUMULATED, not overwritten. `degraded = m` kept only the last failure, and
  // answers.jsonl is read first — so with both journals unreadable the ANSWERS
  // message was the one lost, which is the wrong one to drop: an unreadable
  // answers.jsonl makes every answered ask render as pending, a plausible-looking
  // backlog, while an unreadable asks.jsonl merely shows nothing. (P20 NIT.)
  const problems: string[] = [];
  const note = (m: string) => {
    if (!problems.includes(m)) problems.push(m);
  };
  // TWO KINDS OF DEGRADATION, AND THEY MUST NOT BE ONE FLAG.
  //
  // A FILE that could not be opened makes the entry list untrustworthy as a
  // whole: an ask that exists may be missing from it, so answering by id cannot
  // distinguish "no such ask" from "could not look". POST /walkie/answer refuses
  // on that, deliberately.
  //
  // A RECORD that is malformed does not have that property. It was read; the id
  // lookup is exactly as reliable as before. Collapsing the two — which the first
  // version of this change did — made one bad line refuse every answer to every
  // OTHER ask, forever, because this journal is append-only and nothing compacts
  // it. Caught by dogfooding a live server, with 1689 tests and 31/31 mutants
  // green; no unit test in this file had a reason to POST after a malformed read.
  let unreadable: true | undefined;
  const noteUnreadable = (m: string) => {
    unreadable = true;
    note(m);
  };

  const answers = new Map<string, RawAnswer>();
  for (const v of readLines(dir, ANSWER_FILE, noteUnreadable))
    if (isAnswer(v)) answers.set(v.id, v);

  const askLines = readLines(dir, ASK_FILE, noteUnreadable);

  // AN ANSWER CARRIES ONLY AN ID, so an id must identify an ask GLOBALLY. If the
  // same id appears under two different threadIds the join is ambiguous, and
  // attaching the answer to both shows one thread's DECISION inside the other's
  // view. Measured against a live server: `?thread=OTHER` returned OTHER's ask
  // carrying thread `t`'s answer.
  //
  // THE VALIDITY GATE HERE MUST MATCH THE ONE BELOW, and the first version of
  // this did not — it required only an id, while the entry loop also requires a
  // question. So a line this function itself classifies as "skipped: no usable
  // id or question", and never serves to anyone, still voted in the ambiguity
  // election: its absent threadId coerced to "" and counted as a second thread.
  // One appended `{"id":"a1"}` permanently retracted an already-recorded
  // decision — GET showed the ask pending with the answer withheld, POST 409'd
  // forever, and both journals are append-only so it never cleared. A record too
  // malformed to be shown cannot disclose anything across a thread boundary, so
  // it has no business deciding that a disclosure is possible. Reproduced end to
  // end before this was changed.
  //
  // Expressed as ONE parse rather than two matching predicates, because "these
  // two gates must agree" is exactly the invariant that gets forgotten once per
  // site.
  interface ParsedAsk {
    readonly id: string;
    readonly question: string;
    readonly hasThread: boolean;
    readonly threadId: string;
    readonly raw: Record<string, unknown>;
  }
  const parsed: ParsedAsk[] = [];
  let skipped = 0;
  for (const v of askLines) {
    if (!v || typeof v !== "object") {
      skipped++;
      continue;
    }
    const a = v as Record<string, unknown>;
    if (typeof a.id !== "string" || !a.id) {
      skipped++;
      continue;
    }
    if (typeof a.question !== "string" || !a.question) {
      skipped++;
      continue;
    }
    parsed.push({
      id: a.id,
      question: a.question,
      // WHETHER A THREAD WAS STATED AT ALL, kept separate from the coerced value
      // below. A missing threadId becomes "" for serving, and treating that ""
      // as a thread NAME is what left the retraction blocker one key short: the
      // fix required id AND question, so `{"id":"a1"}` stopped voting — and
      // `{"id":"a1","question":"x"}` still permanently retracted a recorded
      // decision, because its absent thread coerced to "" and counted as a
      // second one. A record that names no thread cannot be attributed to a
      // thread, so it cannot establish that an id spans two. Same principle as
      // the malformed records above, one field along.
      hasThread: typeof a.threadId === "string",
      // Compared as the COERCED value, not the raw one: a non-string threadId is
      // emitted as "" below, so filtering on the raw value made an entry visible
      // in the unfiltered list yet unreachable by any ?thread= value.
      threadId: typeof a.threadId === "string" ? a.threadId : "",
      raw: a,
    });
  }

  const threadsById = new Map<string, Set<string>>();
  for (const a of parsed) {
    if (!a.hasThread) continue;
    const set = threadsById.get(a.id);
    if (set) set.add(a.threadId);
    else threadsById.set(a.id, new Set([a.threadId]));
  }
  const ambiguous = new Set<string>();
  for (const [id, threads] of threadsById) if (threads.size > 1) ambiguous.add(id);

  const seen = new Set<string>();
  const entries: AskEntry[] = [];
  // Records that are SERVED but incomplete. Counted, not coerced in silence —
  // `degraded` exists so a read that could not see everything never renders as
  // "nothing pending", and a record served with its identity fields blanked is
  // that failure one size down.
  let incomplete = 0;
  // Which ambiguous ids were actually REACHABLE under this read's filter. A
  // thread-scoped reader told "answers withheld" about a collision living
  // entirely in other threads learns nothing and loses the signal to noise: on a
  // busy deployment the banner would be permanently on for everyone, because the
  // journal is append-only. So the note is scoped to what this caller can see.
  const ambiguousHere = new Set<string>();
  for (const a of parsed) {
    if (opts?.threadId !== undefined && a.threadId !== opts.threadId) continue;
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    if (ambiguous.has(a.id)) ambiguousHere.add(a.id);
    const raw = a.raw;

    const options: AskOption[] = Array.isArray(raw.options)
      ? raw.options.flatMap((o) => {
          if (!o || typeof o !== "object") return [];
          const opt = o as Record<string, unknown>;
          if (typeof opt.label !== "string" || !opt.label) return [];
          return [
            typeof opt.description === "string"
              ? { label: opt.label, description: opt.description }
              : { label: opt.label },
          ];
        })
      : [];

    // Served, but ACCOUNTED FOR. Dropping the record would turn a partial write
    // into an absent ask, which is the worse of the two failures; coercing in
    // silence tells the client the ask is fine. So: serve it, and say so.

    // Ambiguous ids get NO answer. Not the first and not the last: either choice
    // is a guess, and a guess here is disclosure.
    const ans = ambiguous.has(a.id) ? undefined : answers.get(a.id);
    if (ans && opts?.includeAnswered !== true) continue;

    // COUNTED HERE, below the answered filter, so the number describes what was
    // actually SERVED — which is what the comment always claimed and the code
    // did not. Counted above, an answered malformed record put a permanent
    // "some rows may be wrong" banner over a pending list in which every row was
    // right, on an append-only journal that never clears.
    if (
      typeof raw.sessionId !== "string" ||
      !raw.sessionId ||
      typeof raw.createdAt !== "string" ||
      !raw.createdAt
    ) {
      incomplete++;
    }

    entries.push({
      id: a.id,
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
      threadId: a.threadId,
      question: a.question,
      ...(typeof raw.header === "string" ? { header: raw.header } : {}),
      // VALIDATED, not cast. `Array.isArray` alone let `[1, null, {label:{}}]`
      // through as `readonly AskOption[]`, and a client looping `opt.label` gets
      // a TypeError on the null while React throws on the object. This file
      // reads a journal other processes append to, so the array's shape is an
      // input, not an invariant. (P20 MAJOR.)
      ...(options.length > 0 ? { options } : {}),
      ...(typeof raw.multiSelect === "boolean" ? { multiSelect: raw.multiSelect } : {}),
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
      status: ans ? "answered" : "pending",
      // SURFACED PER ENTRY, not just as an aggregate count. The server computes
      // this inside the very call the GET makes and used to discard it, so GET
      // said `pending` while POST returned 409 forever for the same id — two
      // endpoints of one API contradicting each other about one resource, with
      // no way for a client to tell which ask was affected. A client can now
      // disable the control and say why.
      ...(ambiguous.has(a.id) ? { ambiguous: true as const } : {}),
      ...(ans ? { answer: ans.answer } : {}),
      ...(ans?.answeredAt ? { answeredAt: ans.answeredAt } : {}),
    });
  }
  if (ambiguousHere.size > 0)
    note(`${ambiguousHere.size} ask id(s) appear under more than one thread; answers withheld`);
  if (skipped > 0) note(`${skipped} ask record(s) skipped: no usable id or question`);
  if (incomplete > 0) note(`${incomplete} ask record(s) missing sessionId or createdAt`);
  return {
    entries,
    ...(problems.length > 0 ? { degraded: problems.join("; ") } : {}),
    ...(unreadable ? { unreadable } : {}),
    ...(ambiguous.size > 0 ? { ambiguous } : {}),
  };
}
