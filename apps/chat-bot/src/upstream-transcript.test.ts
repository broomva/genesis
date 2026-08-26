import { describe, expect, test } from "bun:test";
import { upstreamTranscript } from "./upstream-transcript";

/** The 2026-08-26T15:24:48Z payload, copied out of the journal rather than
 *  imagined. A fixture the author invented would encode the author's guess at
 *  the vendor's format; this one encodes the vendor's. */
const REAL =
  "Audio attached (audio_712bb19e4d77.ogg) [Size: 12.5 KB | Type: audio/ogg] URL: " +
  "https://app.kapso.ai/rails/active_storage/blobs/redirect/" +
  "eyJfcmFpbHMiOnsiZGF0YSI6IjI3NGFlMTU0LThkNjAtNGRjYS1hZWNjLTAyZDU2ZDEyM2EyNSIsInB1ciI6ImJsb2JfaWQifX0=" +
  "--7916bc2c5dd4fb4e036bcf0b6935e0105bf1b3e6/audio_712bb19e4d77.ogg\n\n" +
  "Transcript: Can we have a voice notes conversation or can you send me audio?";

describe("a transcript the channel supplied", () => {
  test("is read out of the real payload", () => {
    expect(upstreamTranscript(REAL)).toBe(
      "Can we have a voice notes conversation or can you send me audio?",
    );
  });

  test("carries none of the envelope with it", () => {
    const spoken = upstreamTranscript(REAL) ?? "";
    // The defect this pins is not cosmetic: the envelope was what reached the
    // agent as the user's prompt, so a ~200-character signed blob URL was the
    // loudest thing in it.
    expect(spoken).not.toContain("Audio attached");
    expect(spoken).not.toContain("kapso.ai");
    expect(spoken).not.toContain("Transcript:");
  });

  test("survives a transcript that itself spans lines", () => {
    const spoken = upstreamTranscript(`${REAL}\nand a second sentence.`);
    expect(spoken).toBe(
      "Can we have a voice notes conversation or can you send me audio?\nand a second sentence.",
    );
  });
});

describe("everything else is left alone", () => {
  // The anti-vacuity direction. A parser that returned the tail of any string
  // containing "Transcript:" would pass the block above and mangle ordinary
  // messages; these are the inputs that must NOT be treated as transcripts.

  test("plain text is not a transcript", () => {
    expect(upstreamTranscript("can you hear me?")).toBeUndefined();
  });

  test("a typed message merely mentioning a transcript is not one", () => {
    expect(upstreamTranscript("Send me the Transcript: of yesterday's call")).toBeUndefined();
  });

  test("an envelope with no marker is not one", () => {
    expect(
      upstreamTranscript("Audio attached (a.ogg) [Size: 1 KB | Type: audio/ogg] URL: https://x/a.ogg"),
    ).toBeUndefined();
  });

  test("an envelope with an EMPTY transcript is not one", () => {
    // Kapso emitting the marker with nothing after it means it failed to hear
    // the note. Returning "" would dispatch an empty prompt; undefined routes
    // to the advisory, which in that case is true.
    expect(upstreamTranscript("Audio attached (a.ogg)\n\nTranscript:   \n  ")).toBeUndefined();
  });

  test("a caption BEFORE the envelope is not consumed", () => {
    // Anchoring is what protects the typed words here. Unanchored, this would
    // return only the transcript and the sender's caption would vanish.
    const captioned = `please listen to this\n\n${REAL}`;
    expect(upstreamTranscript(captioned)).toBeUndefined();
  });

  test("empty and undefined are handled", () => {
    expect(upstreamTranscript(undefined)).toBeUndefined();
    expect(upstreamTranscript("")).toBeUndefined();
  });
});
