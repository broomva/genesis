// A channel that transcribes voice notes for us, upstream of this bot.
//
// THE BUG THIS CLOSES. voice-note.ts was written on a premise that is true of
// the Chat SDK and false of the live channel: that a voice note arrives as
// opaque audio nobody here can read. Kapso transcribes it and inlines the
// result INTO the message text. So on 2026-08-26T15:24:48Z a real voice note
// was answered — correctly, from its transcript — and the sender was told in
// the same turn "I can't listen to voice notes yet, so I skipped the audio."
//
// That advisory was not merely noise. The note it apologised for was the very
// question it had just answered, and the question was whether this bot can
// hold a voice conversation. The most confusing possible reply to "can you
// hear me?" is a correct answer stapled to a denial that it was heard.
//
// WHY THE PARSE LIVES APART FROM THE DECISION. The shape below is a vendor's
// and can change with no warning to us. Isolated here, a changed format makes
// this return undefined and the caller falls back to the honest advisory: a
// stale format costs the nicety, never the turn. Folded into the decision
// logic, the same change would be a crash on the dispatch path.

/** The machine-generated envelope, verbatim from the 2026-08-26 payload:
 *
 *     Audio attached (audio_712bb19e4d77.ogg) [Size: 12.5 KB | Type: audio/ogg]
 *     URL: https://app.kapso.ai/rails/active_storage/blobs/redirect/eyJ…ogg
 *
 *     Transcript: Can we have a voice notes conversation or can you send me audio?
 *
 *  MATCHED WHOLE, as one shape, and this is the load-bearing decision.
 *
 *  A first cut anchored only the opening words and then searched forward for a
 *  `Transcript:` line. Review broke it in one move, by executing it: a person
 *  who types
 *
 *     Audio attached (interview.ogg)
 *     Please summarize and preserve speaker names.
 *     Transcript: Alice: revenue rose.
 *
 *  alongside an audio file got back only "Alice: revenue rose." — their actual
 *  instruction silently deleted. The anchor guarded against a caption BEFORE
 *  the envelope and left the gap INSIDE it wide open, which is the same
 *  invariant (never discard what a human typed) forgotten in the one branch I
 *  did not enumerate.
 *
 *  ROUND 2 BLOCKED IT AGAIN, on a different branch of the same regex. The
 *  header was required to be one line, but the metadata slot was a wildcard,
 *  so
 *
 *     Audio attached (interview.ogg) Please summarize and preserve speaker
 *     names. URL: https://x/interview.ogg
 *     Transcript: Alice: revenue rose.
 *
 *  still returned only "Alice: revenue rose." That is the SAME invariant —
 *  never delete what a human typed — broken for the third time in a third
 *  branch. Tightening one more branch would only move the hole; a wildcard
 *  anywhere in this pattern is a place a human's words can go to die.
 *
 *  So there is no wildcard left. Every span is an exact grammar: the literal
 *  words, a parenthesised filename, Kapso's `[Size: … | Type: …]` block, the
 *  URL, the marker. Nothing between them is free text.
 *
 *  AND recognition is gated on the channel, which is the actual root of the
 *  class. This envelope is one vendor's; it has no business being recognised
 *  on a Telegram audio caption at all. Round 2 called the "it is a format
 *  recogniser, not a vendor hook" defence rationalisation, and it was right:
 *  the funnel it sits in is channel-agnostic, so without a gate the parse ran
 *  on every channel's audio.
 *
 *  The leading `^` is not decoration: it is what keeps matching linear.
 *  Mutation-tested by deleting it, at which point a two-megabyte run of
 *  spaces sends the engine into catastrophic backtracking and the suite stops
 *  finishing. Bounds alone did NOT save it — the anchor does that work, so do
 *  not "simplify" it away because the rest of the pattern looks safe.
 *
 *  Brackets are PAIRED by alternation rather than independently optional,
 *  which round 2 found accepted malformed `[Audio attached (a.ogg) …`. */
/** The filename slot — and the reason this pattern finally converges.
 *
 *  Round 3 blocked on THIS span, having already blocked on two others, and
 *  named the reason: "inferring provenance from text shape keeps recreating
 *  the same deletion risk." Every span I made exact turned the next one into
 *  the hole — caption, then metadata, then here, where
 *
 *      Audio attached (a.ogg — please summarize and preserve speaker names)
 *      [Size: 1 KB | Type: audio/ogg] URL: https://x/a.ogg
 *      Transcript: Alice: revenue rose.
 *
 *  deleted the instruction. My "no wildcard left" claim was simply false.
 *
 *  What stops the regress is not another tightening but an invariant that can
 *  be CHECKED BY INSPECTION over the whole header:
 *
 *      NO SPAN OF THE HEADER ADMITS WHITESPACE-BEARING FREE TEXT.
 *
 *  Prose requires whitespace. The literal words are fixed; METADATA is an
 *  exact grammar; URL_PART is `\S`-only; this was the last span that allowed
 *  a space, and now does not. There is no remaining place for a sentence to
 *  hide, so the next round has nowhere to relocate the finding — which is the
 *  property the previous three fixes lacked.
 *
 *  It costs nothing real: Kapso names these itself (`audio_712bb19e4d77.ogg`),
 *  and a filename with a space in it is not one of ours.
 *
 *  This does NOT make text-shape inference sound. A provenance-bearing field
 *  from the adapter is still the right answer, and BRO-2393 keeps it open. */
const FILENAME = /\([^\s)]{1,255}\)/.source;
const METADATA = /\[Size:[ \t]*[\d.,]{1,15}[ \t]*[KMGT]?B[ \t]*\|[ \t]*Type:[ \t]*[\w.+-]{1,64}\/[\w.+-]{1,64}\]/.source;
const URL_PART = /URL:[ \t]*\S{1,2048}/.source;

const ENVELOPE_WITH_TRANSCRIPT = new RegExp(
  `^[ \\t]*(?:\\[Audio attached\\]|Audio attached)[ \\t]*${FILENAME}[ \\t]*${METADATA}[ \\t]*${URL_PART}[ \\t]*\\r?\\n\\s{0,64}Transcript:[ \\t]*([\\s\\S]*)$`,
);

/** Channels known to transcribe voice notes upstream and inline the result.
 *
 *  A thread id carries its channel as a prefix ("kapso:<a>:<b>:<c>"). Gating
 *  here rather than at the call site keeps every fact about a vendor's wire
 *  format inside this one file. */
export function transcribesUpstream(threadId: string): boolean {
  return threadId.startsWith("kapso:");
}

/** The spoken words a channel already transcribed for us, or undefined when
 *  this text is not such an envelope.
 *
 *  Undefined is the safe answer and the default: every unrecognised shape
 *  returns it, and the caller then behaves exactly as it did before this
 *  module existed. */
export function upstreamTranscript(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const spoken = ENVELOPE_WITH_TRANSCRIPT.exec(text)?.[1]?.trim();
  return spoken ? spoken : undefined;
}
