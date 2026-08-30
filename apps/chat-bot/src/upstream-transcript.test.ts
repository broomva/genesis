import { describe, expect, test } from "bun:test";
import { transcribesUpstream, upstreamTranscript } from "./upstream-transcript";

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
      upstreamTranscript(
        "Audio attached (a.ogg) [Size: 1 KB | Type: audio/ogg] URL: https://x/a.ogg",
      ),
    ).toBeUndefined();
  });

  test("an envelope with an EMPTY transcript is not one", () => {
    // Kapso emitting the marker with nothing after it means it failed to hear
    // the note. Returning "" would dispatch an empty prompt; undefined routes
    // to the advisory, which in that case is true.
    // A COMPLETE envelope, so the only thing that can reject it is the empty
    // transcript itself. Tightening the header made an earlier version of this
    // test pass for the wrong reason — it had no URL, so it never reached the
    // guard it was written to pin.
    expect(
      upstreamTranscript(
        "Audio attached (a.ogg) [Size: 1 KB | Type: audio/ogg] URL: https://x/a.ogg\n\nTranscript:   \n  ",
      ),
    ).toBeUndefined();
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

describe("a human's typed words are never deleted (P20 round 1, BLOCKER)", () => {
  // These inputs are the reviewer's, verbatim. It did not argue the first one
  // was possible — it ran the code and printed the deletion.

  test("a typed instruction between the opening words and a Transcript: line survives", () => {
    const typedByAPerson =
      "Audio attached (interview.ogg)\n" +
      "Please summarize and preserve speaker names.\n" +
      "Transcript: Alice: revenue rose.";
    // Not an envelope: the header is broken across lines and carries no URL.
    // Falling through means the WHOLE message is dispatched, instruction intact.
    expect(upstreamTranscript(typedByAPerson)).toBeUndefined();
  });

  test("the bracketed variant of the envelope is still read", () => {
    // Kapso's other documented emission. Left unhandled it would have kept
    // producing the exact false advisory this change exists to remove.
    const bracketed =
      "[Audio attached] (voice.ogg) [Size: 50 KB | Type: audio/ogg] " +
      "URL: https://api.kapso.ai/media/x\nTranscript: Hello, I need help with my order";
    expect(upstreamTranscript(bracketed)).toBe("Hello, I need help with my order");
  });

  test("a header without a URL is not an envelope", () => {
    expect(
      upstreamTranscript("Audio attached (a.ogg) [Size: 1 KB | Type: audio/ogg]\nTranscript: hi"),
    ).toBeUndefined();
  });

  test("a header split across lines is not an envelope", () => {
    expect(
      upstreamTranscript("Audio attached (a.ogg)\nURL: https://x/a.ogg\nTranscript: hi"),
    ).toBeUndefined();
  });

  test("matching stays linear on pathological input", () => {
    const hostile = `Audio attached (${"a".repeat(200)}) ${"b".repeat(500)} URL: https://x/${"c".repeat(2000)}\n${" ".repeat(60)}Transcript: ${"d".repeat(50_000)}`;
    const started = performance.now();
    upstreamTranscript(hostile);
    upstreamTranscript(`${" ".repeat(2_000_000)}X`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("no wildcard is left for a human's words to fall into (P20 round 2)", () => {
  // Round 2's blocker, verbatim. Round 1's blocker was the same invariant in
  // a different branch; this is the third. The fix was not another tightening
  // but removing free text from the grammar entirely, so the test that matters
  // is whether an instruction can hide ANYWHERE inside the header.

  test("a same-line instruction in the metadata slot is not swallowed", () => {
    expect(
      upstreamTranscript(
        "Audio attached (interview.ogg) Please summarize and preserve speaker names. " +
          "URL: https://x/interview.ogg\nTranscript: Alice: revenue rose.",
      ),
    ).toBeUndefined();
  });

  test("an instruction before the URL, with real metadata present, is not swallowed", () => {
    expect(
      upstreamTranscript(
        "Audio attached (a.ogg) [Size: 1 KB | Type: audio/ogg] and please reply in Spanish " +
          "URL: https://x/a.ogg\nTranscript: hola",
      ),
    ).toBeUndefined();
  });

  test("an instruction between the words and the filename is not swallowed", () => {
    expect(
      upstreamTranscript(
        "Audio attached please be brief (a.ogg) [Size: 1 KB | Type: audio/ogg] " +
          "URL: https://x/a.ogg\nTranscript: hi",
      ),
    ).toBeUndefined();
  });

  test("unpaired brackets are rejected", () => {
    // Round 2 MAJOR 2: independently optional brackets accepted this.
    expect(
      upstreamTranscript(
        "[Audio attached (a.ogg) [Size: 1 KB | Type: audio/ogg] URL: https://x/a.ogg\nTranscript: hello",
      ),
    ).toBeUndefined();
  });

  test("junk in the metadata slot is rejected", () => {
    expect(
      upstreamTranscript("Audio attached (a.ogg) [whatever] URL: https://x/a.ogg\nTranscript: hi"),
    ).toBeUndefined();
  });
});

describe("the filename bound is a real boundary, not decoration", () => {
  // Round 2 was right and I was wrong: I called the surviving {1,255} mutant a
  // no-behaviour bound. It differs from `+` at exactly 256 characters, so it
  // needed a boundary test rather than an assertion that it did not.
  const envelope = (name: string) =>
    `Audio attached (${name}) [Size: 1 KB | Type: audio/ogg] URL: https://x/a.ogg\nTranscript: hi`;

  test("255 characters is accepted", () => {
    expect(upstreamTranscript(envelope("a".repeat(255)))).toBe("hi");
  });

  test("256 characters is rejected", () => {
    expect(upstreamTranscript(envelope("a".repeat(256)))).toBeUndefined();
  });
});

describe("only a channel that actually transcribes is parsed", () => {
  test("kapso threads are", () => {
    expect(transcribesUpstream("kapso:MTMxNDAx:NTczMDE3:MjY4ZjE3")).toBe(true);
  });

  test("telegram and other channels are not", () => {
    expect(transcribesUpstream("telegram:1")).toBe(false);
    expect(transcribesUpstream("slack:C123:456")).toBe(false);
    expect(transcribesUpstream("")).toBe(false);
  });

  test("a channel merely containing the name is not", () => {
    expect(transcribesUpstream("telegram:not-kapso:1")).toBe(false);
  });
});

describe("the header admits no whitespace-bearing free text (P20 round 3)", () => {
  // Round 3's blocker was the filename slot — the third span in three rounds.
  // These pin the INVARIANT rather than the one input: a sentence needs
  // spaces, so if no span accepts a space, no span can swallow a sentence.

  test("prose inside the filename parens is not an envelope", () => {
    expect(
      upstreamTranscript(
        "Audio attached (a.ogg — please summarize and preserve speaker names) " +
          "[Size: 1 KB | Type: audio/ogg] URL: https://x/a.ogg\nTranscript: Alice: revenue rose.",
      ),
    ).toBeUndefined();
  });

  test("a single space in the filename is enough to reject it", () => {
    // The boundary of the invariant, not a restatement of the case above.
    expect(
      upstreamTranscript(
        "Audio attached (a b.ogg) [Size: 1 KB | Type: audio/ogg] URL: https://x/a.ogg\nTranscript: hi",
      ),
    ).toBeUndefined();
  });

  test("real Kapso filenames still pass", () => {
    // The other half of the bidirectional proof: tightening must not have
    // overshot into rejecting the vendor's actual values.
    for (const name of [
      "audio_712bb19e4d77.ogg",
      "voice.ogg",
      "a-b.c.ogg",
      "AUDIO-2026.08.26.oga",
    ]) {
      expect(
        upstreamTranscript(
          `Audio attached (${name}) [Size: 12.5 KB | Type: audio/ogg] URL: https://x/${name}\nTranscript: heard`,
        ),
      ).toBe("heard");
    }
  });
});
