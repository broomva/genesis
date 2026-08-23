// Inbound voice notes (BRO-2266).
//
// WHY THIS EXISTS. A WhatsApp voice note carries no text, and the handler
// dispatches on `message.text`. So until now a voice note was SILENTLY
// DROPPED: no reply, no log, nothing on the sender's phone — indistinguishable
// from the bot being dead. That is the same silence-as-failure mode the rest of
// BRO-2256 exists to remove, and it is the reason the no-transcriber path here
// answers rather than returns.
//
// WHAT IS ALREADY SOLVED. Download is not our problem: Chat SDK's `Attachment`
// carries `fetchData()`, and `@kapso/chat-adapter` 0.1.1 builds audio
// attachments from the webhook's `raw.audio` and knows how to rehydrate the
// WhatsApp mediaId behind it (read from `dist`; the docs describe none of it).
// Only transcription is missing, and the BACKEND for that is deliberately not
// chosen here — see `Transcriber`.

/** The slice of Chat SDK's `Attachment` this module needs. Narrow so the unit
 *  tests do not have to construct a whole SDK object. */
export interface AudioAttachment {
  readonly type: "image" | "file" | "video" | "audio";
  readonly mimeType?: string;
  readonly size?: number;
  readonly data?: Buffer | Blob;
  fetchData?: () => Promise<Buffer>;
}

/** Transcription backend. A PORT, not an implementation.
 *
 *  The backend is an operator decision with real trade-offs — whisper.cpp on
 *  the VPS costs CPU on a 2-vCPU box, an API costs money and adds a vendor — so
 *  this module refuses to pick one. Everything here works identically behind
 *  either, and the choice plugs in at the entrypoint. */
export interface Transcriber {
  /** Return the spoken text. Throwing is fine; callers treat it as a failure
   *  the user is told about, never as a silent drop. */
  transcribe(audio: Buffer, mimeType?: string): Promise<string>;
}

/** Largest voice note we will pull into memory.
 *
 *  WhatsApp caps audio at 16 MB, so this is not primarily a protocol bound — it
 *  is a memory bound on a 2-vCPU / 8 GB box that has already been taken down
 *  once today by resource exhaustion. `fetchData()` buffers the WHOLE file, and
 *  a channel that anyone with the number can post to must not be able to choose
 *  our allocation size. Checked BEFORE the download, from the attachment
 *  metadata, so an oversized note is refused rather than fetched and then
 *  rejected. */
export const MAX_VOICE_NOTE_BYTES = 16 * 1024 * 1024;

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

export type VoiceNoteResult =
  /** Transcribed. `text` is what the agent should be asked. */
  | { kind: "text"; text: string }
  /** Could not transcribe. `reply` is what to tell the user — NEVER silence. */
  | { kind: "refused"; reply: string; reason: string };

/** The message shown when no backend is configured.
 *
 *  Deliberately says what the user can DO. "Unsupported media type" tells them
 *  nothing; "type it instead" is actionable and true. */
export const NO_TRANSCRIBER_REPLY =
  "I can't listen to voice notes yet — could you type that instead?";

/** Turn a voice note into text, or into something to say about why not.
 *
 *  Never throws and never returns nothing: every path produces either text to
 *  dispatch or a reply to post. That total-ness is the point of the module. */
export async function resolveVoiceNote(
  attachment: AudioAttachment,
  transcriber: Transcriber | undefined,
): Promise<VoiceNoteResult> {
  if (!transcriber) {
    return {
      kind: "refused",
      reply: NO_TRANSCRIBER_REPLY,
      reason: "no transcriber configured",
    };
  }

  // Size gate BEFORE the fetch — see MAX_VOICE_NOTE_BYTES. `size` is optional
  // in the SDK type, so an absent size is not treated as zero: it is unknown,
  // and the post-download check below is what covers that case.
  if (typeof attachment.size === "number" && attachment.size > MAX_VOICE_NOTE_BYTES) {
    return {
      kind: "refused",
      reply: "That voice note is too long for me to process — could you send a shorter one?",
      reason: `declared size ${attachment.size} exceeds ${MAX_VOICE_NOTE_BYTES}`,
    };
  }

  let audio: Buffer;
  try {
    audio = attachment.data instanceof Buffer ? attachment.data : await fetchAudio(attachment);
  } catch (e) {
    return {
      kind: "refused",
      reply: "I couldn't download that voice note — could you try again, or type it?",
      reason: `download failed: ${errText(e)}`,
    };
  }

  // Second size check, on what actually arrived. The declared size is metadata
  // from the sender's side; this is the only figure we have measured.
  if (audio.byteLength > MAX_VOICE_NOTE_BYTES) {
    return {
      kind: "refused",
      reply: "That voice note is too long for me to process — could you send a shorter one?",
      reason: `downloaded ${audio.byteLength} bytes exceeds ${MAX_VOICE_NOTE_BYTES}`,
    };
  }
  if (audio.byteLength === 0) {
    return {
      kind: "refused",
      reply: "That voice note came through empty — could you send it again?",
      reason: "empty audio",
    };
  }

  let text: string;
  try {
    text = await transcriber.transcribe(audio, attachment.mimeType);
  } catch (e) {
    return {
      kind: "refused",
      reply: "I couldn't make out that voice note — could you try again, or type it?",
      reason: `transcription failed: ${errText(e)}`,
    };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    // A transcriber that returns "" has succeeded at producing nothing. Feeding
    // that to the agent would start a turn on an empty prompt, which the
    // handler drops — silently, which is the whole thing we are avoiding.
    return {
      kind: "refused",
      reply: "I couldn't hear anything in that voice note — could you try again?",
      reason: "transcript empty",
    };
  }
  return { kind: "text", text: trimmed };
}

async function fetchAudio(a: AudioAttachment): Promise<Buffer> {
  if (!a.fetchData) throw new Error("attachment has no fetchData()");
  return await a.fetchData();
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
