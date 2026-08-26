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
 *  So the header is now required to be intact and machine-shaped: a bracketed
 *  filename, then whatever metadata, then `URL:` and a URL, ALL ON ONE LINE,
 *  and the transcript marker immediately after it. A human typing prose cannot
 *  produce that by accident, and one who reproduces it exactly has typed the
 *  transcript they then get answered on.
 *
 *  Every quantifier is bounded, so matching is linear in the input and no
 *  pathological message can make it climb.
 *
 *  `[Audio attached]` bracketed is Kapso's other documented emission; both are
 *  accepted, because the variant that reaches us is not ours to choose. */
const ENVELOPE_WITH_TRANSCRIPT =
  /^[ \t]*\[?Audio attached\]?[ \t]*\([^)\n]{1,255}\)[^\n]{0,512}\bURL:[ \t]*\S{1,2048}[ \t]*\r?\n\s{0,64}Transcript:[ \t]*([\s\S]*)$/;

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
