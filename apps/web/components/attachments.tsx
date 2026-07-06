"use client";

import type { FileUIPart } from "ai";
import { FileText, Paperclip, X } from "lucide-react";

import { useProviderAttachments } from "@/components/ai-elements/prompt-input";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { cn } from "@/lib/utils";

// Multimodal attachment UI (BRO-1706) — composes the DS attachment kit
// (components/ui/attachment.tsx) into (a) a pending-attachment row shown in the
// composer as feedback while files are staged, and (b) the sent-message renderer
// that shows attached images/files inline in the user bubble.

function isImage(mediaType?: string): boolean {
  return !!mediaType && mediaType.startsWith("image/");
}

/** Short human label for the chip's secondary line (no size — FileUIPart carries
 *  none pre-send; the thumbnail/type is the signal). */
function kindLabel(mediaType?: string, filename?: string): string {
  if (mediaType) {
    if (mediaType.startsWith("image/")) return `${mediaType.slice(6).toUpperCase()} image`;
    if (mediaType === "application/pdf") return "PDF document";
    if (mediaType.startsWith("text/")) return "Text file";
  }
  const ext = filename?.includes(".") ? filename.split(".").pop() : undefined;
  return ext ? `${ext.toUpperCase()} file` : "File";
}

function FileGlyph({ mediaType }: { mediaType?: string }) {
  if (mediaType === "application/pdf" || mediaType?.startsWith("text/")) {
    return <FileText />;
  }
  return <Paperclip />;
}

/** One attachment as a horizontal chip: image thumbnail (or a file-type glyph) +
 *  filename + type, with an optional remove button (staged files only). */
function AttachmentChip({
  file,
  onRemove,
}: {
  file: FileUIPart;
  onRemove?: () => void;
}) {
  const img = isImage(file.mediaType);
  const name = file.filename ?? "attachment";
  return (
    <Attachment orientation="horizontal" size="sm" className="max-w-56">
      <AttachmentMedia variant={img ? "image" : "icon"}>
        {img ? (
          // Thumbnail — filename lives in the title, so the image is decorative.
          <img src={file.url} alt="" />
        ) : (
          <FileGlyph mediaType={file.mediaType} />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
        <AttachmentDescription>{kindLabel(file.mediaType, file.filename)}</AttachmentDescription>
      </AttachmentContent>
      {onRemove ? (
        <AttachmentActions>
          <AttachmentAction aria-label={`Remove ${name}`} onClick={onRemove}>
            <X className="size-3.5" />
          </AttachmentAction>
        </AttachmentActions>
      ) : null}
    </Attachment>
  );
}

/** The staged-attachment row shown in the composer (BRO-1706). Reads the provider
 *  attachment state, so it must render inside a <PromptInputProvider>. Empty →
 *  renders nothing (no layout footprint until a file is staged). */
export function ComposerAttachments({ className }: { className?: string }) {
  const { files, remove } = useProviderAttachments();
  if (files.length === 0) return null;
  return (
    <AttachmentGroup className={cn("px-0.5", className)}>
      {files.map((f) => (
        <AttachmentChip key={f.id} file={f} onRemove={() => remove(f.id)} />
      ))}
    </AttachmentGroup>
  );
}

/** Attached files rendered inline in a SENT message (BRO-1706). Filters the
 *  message parts to `file` parts and shows them as chips (right-aligned to sit under
 *  the user bubble). Renders nothing when the message carries no attachments. */
export function MessageAttachments({
  parts,
  className,
}: {
  parts: readonly unknown[];
  className?: string;
}) {
  const files = parts.filter(
    (p): p is FileUIPart =>
      !!p && typeof p === "object" && (p as { type?: string }).type === "file",
  );
  if (files.length === 0) return null;
  return (
    <AttachmentGroup className={cn("max-w-[78%] justify-end", className)}>
      {files.map((f, i) => (
        <AttachmentChip key={`${f.filename ?? "file"}-${i}`} file={f} />
      ))}
    </AttachmentGroup>
  );
}
