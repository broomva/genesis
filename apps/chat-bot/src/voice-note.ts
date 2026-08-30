// Inbound voice notes (BRO-2266) — the ANSWER, not yet the ingestion.
//
// THE BUG THIS CLOSES. A WhatsApp voice note carries no text, and dispatch runs
// on `message.text`, so one was SILENTLY DROPPED: no reply, no log, nothing on
// the sender's phone — indistinguishable from a dead bot. That is the same
// silence-as-failure mode the rest of BRO-2256 was about.
//
// WHY THERE IS NO DOWNLOAD OR TRANSCRIPTION HERE. An earlier cut of this file
// carried the whole ingestion path — fetchData(), size bounds, a Transcriber
// port. Cross-model review found two blockers in it, and both were in code that
// CANNOT RUN: with no backend configured the function returns at the first
// branch and never downloads anything. The findings were real —
//
//   - `fetchData()` buffers the entire object before any length we can measure,
//     so a post-download check bounds nothing; the only pre-emptive gate reads
//     the sender's own declared `size`, which is metadata, not a measurement.
//   - bytes do not bound COST for compressed audio: 16 MB of Opus is hours of
//     speech, so a byte cap limits allocation and not transcription time, and
//     nothing limited concurrency on a 2-vCPU box.
//
// — and neither is answerable without knowing the backend, because the fix
// differs entirely between a local decoder and a hosted API. Shipping the
// boundary now would be designing it blind and then defending the design.
// It lands with the backend, in BRO-2266.
//
// What remains is live, small, and the part that actually helps today.

import { transcribesUpstream, upstreamTranscript } from "./upstream-transcript";

/** The slice of Chat SDK's `Attachment` this module needs. */
export interface AudioAttachment {
  readonly type: "image" | "file" | "video" | "audio";
  readonly mimeType?: string;
  readonly size?: number;
}

/** Is this the audio attachment of a voice note? */
export function isAudio(a: AudioAttachment): boolean {
  return a.type === "audio";
}

/** The first audio attachment on a message, if any. */
export function findVoiceNote(
  attachments: readonly AudioAttachment[],
): AudioAttachment | undefined {
  return attachments.find(isAudio);
}

/** Shown when a voice note arrives and we cannot listen to it.
 *
 *  Says what the sender can DO. "Unsupported media type" tells them nothing;
 *  "type it instead" is actionable and true. */
export const CANNOT_HEAR_REPLY = "I can't listen to voice notes yet — could you type that instead?";

/** Shown when a message carries BOTH text and a voice note.
 *
 *  The typed words are dispatched, because they are the higher-confidence
 *  signal. But dropping the audio without saying so would be a silent discard
 *  committed by the very module whose purpose is to end silent discards —
 *  cross-model review caught that inconsistency, and it was correct. */
export const AUDIO_IGNORED_NOTE =
  "(I answered your typed message — I can't listen to voice notes yet, so I skipped the audio.)";

/** Ceiling on an ADVISORY post.
 *
 *  The skipped-audio note is a courtesy; the typed turn is the product. Awaiting
 *  it unbounded let a stalled channel request suppress a perfectly valid message
 *  indefinitely — feedback holding the product hostage. That is the THIRD time
 *  this exact shape appeared in this work (BRO-2256 awaited a status reaction on
 *  the dispatch path, then let a never-settling one block the terminal status),
 *  which is why the bound is stated as a named constant rather than fixed in
 *  place: the rule is that no advisory call may gate a turn. (P20 round 2.) */
export const ADVISORY_POST_TIMEOUT_MS = 5_000;

/** The minimum a thread must do for a reply to reach the sender. */
export interface AnswerableThread {
  readonly id: string;
  post(content: string): Promise<unknown>;
}

/** What an inbound message looks like to this module. */
export interface IncomingMessage {
  readonly text?: string;
  readonly attachments?: readonly AudioAttachment[];
}

/** Resolve the text to dispatch, ANSWERING the sender whenever audio is
 *  involved and cannot be used.
 *
 *  Lives here rather than in the entrypoint so the guarantee is testable. The
 *  mutation sweep proved why: with this logic inline in index.ts the only
 *  available assertion was a grep over source, and a no-op that still mentioned
 *  the reply variable SURVIVED it. A claim this module exists to make cannot
 *  rest on a substring match.
 *
 *  Returns undefined when there is nothing to dispatch — which now means the
 *  sender has been told, or the message was genuinely empty. Never "discarded
 *  quietly". */
export async function textToDispatch(
  thread: AnswerableThread,
  message: IncomingMessage,
  log: { warn(m: string): void } = { warn: (m) => console.warn(m) },
  advisoryTimeoutMs: number = ADVISORY_POST_TIMEOUT_MS,
): Promise<string | undefined> {
  const typed = message.text?.trim();
  const note = findVoiceNote(message.attachments ?? []);

  // The channel may have already listened for us. Kapso inlines a transcript
  // into the message text, which made every branch below wrong at once: the
  // audio was NOT skipped, so the advisory lied, and the text dispatched was
  // an "Audio attached (…) URL: …" envelope rather than the spoken question.
  //
  // Gated on `note` so that text alone can never take this path: a sender who
  // types the envelope by hand, with nothing attached, is answered as the
  // typist they are. Gated on the CHANNEL too, because this funnel is shared
  // by every adapter and the envelope belongs to exactly one of them — review
  // found the parse running happily on a Telegram audio caption.
  if (note && transcribesUpstream(thread.id)) {
    const spoken = upstreamTranscript(message.text);
    if (spoken) {
      log.warn(`[genesis-bot] ${thread.id}: answered a voice note transcribed upstream`);
      return spoken;
    }
  }

  if (typed && note) {
    // Both. Dispatch the text, and SAY the audio was skipped — but never let
    // saying so delay the answer by more than ADVISORY_POST_TIMEOUT_MS.
    log.warn(`[genesis-bot] ${thread.id}: answered typed text, skipped an attached voice note`);
    await bounded(
      thread.post(AUDIO_IGNORED_NOTE).catch((e) => {
        log.warn(`[genesis-bot] could not note the skipped audio: ${e}`);
      }),
      advisoryTimeoutMs,
    );
    return typed;
  }
  if (typed) return typed;
  if (!note) return undefined;

  log.warn(`[genesis-bot] ${thread.id}: voice note received, no transcription backend configured`);
  // Bounded for the same reason as the caption path. Review flagged only the
  // mixed-message case, but the defect was at BOTH sites — a fix landing at one
  // of two reachable call sites is a recurring failure in this repo, and the
  // second was found by writing the polarity test rather than by the review.
  await bounded(
    thread.post(CANNOT_HEAR_REPLY).catch((e) => {
      log.warn(`[genesis-bot] could not answer a voice note: ${e}`);
    }),
    advisoryTimeoutMs,
  );
  return undefined;
}

/** Await `p`, or give up after `ms`. Never rejects and never rethrows: an
 *  advisory post that stalls is abandoned, exactly like one that fails.
 *
 *  Abandoning is not cancelling — the request is still on the wire and may
 *  still land. That is fine HERE, unlike for a status reaction, because this
 *  note carries no state: arriving late makes it redundant, not wrong. */
async function bounded(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      p,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch {
    // abandoned
  } finally {
    if (timer) clearTimeout(timer);
  }
}
