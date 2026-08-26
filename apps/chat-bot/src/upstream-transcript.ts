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

/** Kapso's inlined-transcript envelope, verbatim from the 2026-08-26 payload:
 *
 *     Audio attached (audio_712bb19e4d77.ogg) [Size: 12.5 KB | Type: audio/ogg]
 *     URL: https://app.kapso.ai/rails/active_storage/blobs/redirect/eyJ…ogg
 *
 *     Transcript: Can we have a voice notes conversation or can you send me audio?
 *
 *  ANCHORED AT THE START, deliberately. A message whose text merely *contains*
 *  the envelope may carry a typed caption before it, and returning only the
 *  transcript would silently discard what the sender typed — trading a wrong
 *  advisory for lost words, which is the worse defect. Unanchored input falls
 *  through to the existing both-text-and-audio path, where the caption is
 *  dispatched and the advisory is once again true of the audio. */
const ENVELOPE = /^\s*Audio attached \(/;

/** The transcript marker. Leading newline required: it must be its own line,
 *  not the word "Transcript:" occurring inside the URL or a filename. */
const MARKER = /\n[ \t]*Transcript:[ \t]*/;

/** The spoken words a channel already transcribed for us, or undefined when
 *  this text is not such an envelope.
 *
 *  Undefined is the safe answer and the default: every unrecognised shape
 *  returns it, and the caller then behaves exactly as it did before this
 *  module existed. */
export function upstreamTranscript(text: string | undefined): string | undefined {
  if (!text || !ENVELOPE.test(text)) return undefined;
  const marker = MARKER.exec(text);
  if (!marker) return undefined;
  const spoken = text.slice(marker.index + marker[0].length).trim();
  return spoken.length > 0 ? spoken : undefined;
}
