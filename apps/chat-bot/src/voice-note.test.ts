import { describe, expect, test } from "bun:test";
import {
  type AudioAttachment,
  MAX_VOICE_NOTE_BYTES,
  NO_TRANSCRIBER_REPLY,
  type Transcriber,
  findVoiceNote,
  isAudio,
  resolveVoiceNote,
} from "./voice-note";

const audio = (over: Partial<AudioAttachment> = {}): AudioAttachment => ({
  type: "audio",
  mimeType: "audio/ogg; codecs=opus",
  fetchData: async () => Buffer.from("fake-audio-bytes"),
  ...over,
});

const saying = (text: string): Transcriber => ({ transcribe: async () => text });
const failing = (msg: string): Transcriber => ({
  transcribe: async () => {
    throw new Error(msg);
  },
});

describe("findVoiceNote", () => {
  test("picks the audio attachment out of a mixed set", () => {
    const found = findVoiceNote([
      { type: "image" },
      { type: "file" },
      audio({ mimeType: "audio/mpeg" }),
    ]);
    expect(found?.mimeType).toBe("audio/mpeg");
  });

  test("a message with no audio has no voice note", () => {
    expect(findVoiceNote([{ type: "image" }, { type: "video" }])).toBeUndefined();
    expect(findVoiceNote([])).toBeUndefined();
  });

  test("isAudio does not accept a lookalike type", () => {
    for (const t of ["image", "file", "video"] as const) {
      expect(isAudio({ type: t })).toBe(false);
    }
    expect(isAudio({ type: "audio" })).toBe(true);
  });
});

describe("resolveVoiceNote — every path answers, none is silent", () => {
  test("transcribes and returns the text", async () => {
    const r = await resolveVoiceNote(audio(), saying("  what is the deploy status  "));
    expect(r).toEqual({ kind: "text", text: "what is the deploy status" });
  });

  test("NO transcriber configured -> tells the user, does not drop", async () => {
    // The regression this module exists to prevent. Before it, a voice note
    // produced nothing at all on the sender's phone.
    const r = await resolveVoiceNote(audio(), undefined);
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") {
      expect(r.reply).toBe(NO_TRANSCRIBER_REPLY);
      expect(r.reply.length).toBeGreaterThan(0);
    }
  });

  test("an oversized note is refused BEFORE it is downloaded", async () => {
    // A public number means anyone can choose our allocation size. The declared
    // size must gate the fetch, not merely annotate it.
    let fetched = false;
    const r = await resolveVoiceNote(
      audio({
        size: MAX_VOICE_NOTE_BYTES + 1,
        fetchData: async () => {
          fetched = true;
          return Buffer.alloc(0);
        },
      }),
      saying("never reached"),
    );
    expect(r.kind).toBe("refused");
    expect(fetched).toBe(false);
  });

  test("an UNDECLARED size is still caught after download", async () => {
    // `size` is optional in the SDK type. Trusting its absence as "small" would
    // make the pre-fetch gate the only bound, and it would be bypassable by
    // simply omitting the field.
    const r = await resolveVoiceNote(
      audio({ size: undefined, fetchData: async () => Buffer.alloc(MAX_VOICE_NOTE_BYTES + 1) }),
      saying("never reached"),
    );
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toContain("downloaded");
  });

  test("a note at exactly the limit is ALLOWED", async () => {
    // Polarity partner for the two size tests: a bound that rejects everything
    // would pass both of them.
    const r = await resolveVoiceNote(
      audio({ size: MAX_VOICE_NOTE_BYTES, fetchData: async () => Buffer.alloc(1024, 1) }),
      saying("still here"),
    );
    expect(r).toEqual({ kind: "text", text: "still here" });
  });

  test("a download failure is reported, not swallowed", async () => {
    const r = await resolveVoiceNote(
      audio({
        fetchData: async () => {
          throw new Error("ECONNRESET");
        },
      }),
      saying("never reached"),
    );
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toContain("ECONNRESET");
  });

  test("an attachment with no fetchData is reported, not a crash", async () => {
    const r = await resolveVoiceNote(audio({ fetchData: undefined }), saying("never reached"));
    expect(r.kind).toBe("refused");
  });

  test("a transcriber that throws is reported", async () => {
    const r = await resolveVoiceNote(audio(), failing("model unavailable"));
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toContain("model unavailable");
  });

  test("an EMPTY transcript is refused rather than dispatched", async () => {
    // "" would reach handleAgentMessage, which drops empty input — silently.
    // Succeeding at producing nothing must not look like success.
    for (const empty of ["", "   ", "\n\t"]) {
      const r = await resolveVoiceNote(audio(), saying(empty));
      expect(r.kind).toBe("refused");
    }
  });

  test("zero-byte audio is refused before transcription is attempted", async () => {
    let called = false;
    const r = await resolveVoiceNote(audio({ fetchData: async () => Buffer.alloc(0) }), {
      transcribe: async () => {
        called = true;
        return "x";
      },
    });
    expect(r.kind).toBe("refused");
    expect(called).toBe(false);
  });

  test("pre-fetched data is used without calling fetchData", async () => {
    let fetched = false;
    const r = await resolveVoiceNote(
      audio({
        data: Buffer.from("already here"),
        fetchData: async () => {
          fetched = true;
          return Buffer.from("should not be used");
        },
      }),
      saying("used the buffer"),
    );
    expect(r).toEqual({ kind: "text", text: "used the buffer" });
    expect(fetched).toBe(false);
  });

  test("EVERY refusal carries a non-empty user-facing reply", async () => {
    // The invariant of the whole module: no path may produce silence. A new
    // refusal branch added without a reply fails here.
    const cases: Array<[AudioAttachment, Transcriber | undefined]> = [
      [audio(), undefined],
      [audio({ size: MAX_VOICE_NOTE_BYTES + 1 }), saying("x")],
      [audio({ fetchData: undefined }), saying("x")],
      [audio({ fetchData: async () => Buffer.alloc(0) }), saying("x")],
      [audio(), failing("boom")],
      [audio(), saying("")],
    ];
    for (const [att, t] of cases) {
      const r = await resolveVoiceNote(att, t);
      expect(r.kind).toBe("refused");
      if (r.kind === "refused") {
        expect(r.reply.trim().length).toBeGreaterThan(0);
        expect(r.reason.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
