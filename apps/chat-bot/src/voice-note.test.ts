import { describe, expect, test } from "bun:test";
import {
  ADVISORY_POST_TIMEOUT_MS,
  AUDIO_IGNORED_NOTE,
  type AudioAttachment,
  CANNOT_HEAR_REPLY,
  findVoiceNote,
  isAudio,
  textToDispatch,
} from "./voice-note";

const audio = (over: Partial<AudioAttachment> = {}): AudioAttachment => ({
  type: "audio",
  mimeType: "audio/ogg; codecs=opus",
  ...over,
});

function recordingThread() {
  const posts: string[] = [];
  return {
    posts,
    t: {
      id: "kapso:a:b",
      async post(c: string) {
        posts.push(c);
      },
    },
  };
}
const quiet = { warn: () => {} };

describe("findVoiceNote", () => {
  test("picks the audio attachment out of a mixed set", () => {
    expect(findVoiceNote([{ type: "image" }, { type: "file" }, audio()])?.type).toBe("audio");
  });

  test("a message with no audio has no voice note", () => {
    expect(findVoiceNote([{ type: "image" }, { type: "video" }])).toBeUndefined();
    expect(findVoiceNote([])).toBeUndefined();
  });

  test("isAudio does not accept a lookalike type", () => {
    for (const t of ["image", "file", "video"] as const) expect(isAudio({ type: t })).toBe(false);
    expect(isAudio({ type: "audio" })).toBe(true);
  });
});

describe("textToDispatch — nothing involving audio is ever silent", () => {
  test("a voice note ALONE is answered, and dispatches nothing", async () => {
    // The bug this PR closes: previously the sender saw nothing at all.
    const { posts, t } = recordingThread();
    expect(await textToDispatch(t, { attachments: [audio()] }, quiet)).toBeUndefined();
    expect(posts).toEqual([CANNOT_HEAR_REPLY]);
  });

  test("text PLUS a voice note dispatches the text AND says the audio was skipped", async () => {
    // Cross-model review caught this: silently preferring text is itself a
    // silent discard, committed by the module that exists to end them.
    const { posts, t } = recordingThread();
    const out = await textToDispatch(t, { text: "deploy status", attachments: [audio()] }, quiet);
    expect(out).toBe("deploy status");
    expect(posts).toEqual([AUDIO_IGNORED_NOTE]);
  });

  test("plain text dispatches with NO extra chatter", async () => {
    // Polarity partner: a module that always posts something would pass the two
    // tests above while spamming every ordinary message.
    const { posts, t } = recordingThread();
    expect(await textToDispatch(t, { text: "hello" }, quiet)).toBe("hello");
    expect(posts).toEqual([]);
  });

  test("an empty message stays a no-op and posts nothing", async () => {
    const { posts, t } = recordingThread();
    expect(await textToDispatch(t, { text: "   " }, quiet)).toBeUndefined();
    expect(await textToDispatch(t, {}, quiet)).toBeUndefined();
    expect(await textToDispatch(t, { attachments: [{ type: "image" }] }, quiet)).toBeUndefined();
    expect(posts).toEqual([]);
  });

  test("whitespace-only text with audio is treated as audio-only", async () => {
    const { posts, t } = recordingThread();
    expect(await textToDispatch(t, { text: "  ", attachments: [audio()] }, quiet)).toBeUndefined();
    expect(posts).toEqual([CANNOT_HEAR_REPLY]);
  });

  test("a STALLED advisory post cannot hold back the typed answer", async () => {
    // Third occurrence of this shape in one arc: an advisory feedback call
    // gating the product. The typed message is the product; the skipped-audio
    // note is a courtesy and must never be able to withhold it.
    const t = {
      id: "kapso:a:b",
      post: () => new Promise<void>(() => {}), // never settles
    };
    const started = Date.now();
    const out = await textToDispatch(t, { text: "urgent", attachments: [audio()] }, quiet, 40);
    expect(out).toBe("urgent");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("the advisory bound is a real constant, not an accident", () => {
    expect(ADVISORY_POST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test("a stalled refusal post also cannot hang an audio-only turn", async () => {
    const t = { id: "kapso:a:b", post: () => new Promise<void>(() => {}) };
    const started = Date.now();
    expect(await textToDispatch(t, { attachments: [audio()] }, quiet, 40)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a failing post never throws the turn", async () => {
    const t = {
      id: "kapso:a:b",
      async post() {
        throw new Error("channel down");
      },
    };
    expect(await textToDispatch(t, { attachments: [audio()] }, quiet)).toBeUndefined();
    expect(await textToDispatch(t, { text: "hi", attachments: [audio()] }, quiet)).toBe("hi");
  });

  test("EVERY audio-bearing message produces exactly one reply", async () => {
    // The module's invariant. A branch added later that handles audio without
    // answering fails here.
    for (const m of [
      { attachments: [audio()] },
      { text: "x", attachments: [audio()] },
      { text: "  ", attachments: [audio()] },
      { attachments: [{ type: "image" as const }, audio()] },
    ]) {
      const { posts, t } = recordingThread();
      await textToDispatch(t, m, quiet);
      expect(posts.length).toBe(1);
      expect(posts[0]?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });
});
