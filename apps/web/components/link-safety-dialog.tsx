"use client";

import { Copy, ExternalLink } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Streamdown's external-link confirmation, rendered through our DS Dialog
// (BRO-1589). Streamdown's built-in modal is a bare `fixed inset-0` overlay — but
// it renders INLINE inside the message, and the message scroller establishes
// containing blocks for fixed positioning (`contain: content` on the viewport,
// `content-visibility: auto` on each item). So the streamdown overlay was trapped
// inside the chat column instead of covering the viewport — a patchy blur over
// just the text. Our Dialog uses a Radix Portal → it mounts at document.body,
// escaping those containing blocks, so the scrim covers the whole viewport. The
// URL-preview safety is preserved; only the rendering is ours.
export interface LinkSafetyDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  url: string;
}

export function LinkSafetyDialog({ isOpen, onClose, onConfirm, url }: LinkSafetyDialogProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — the URL is visible on screen to copy manually.
    }
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ExternalLink aria-hidden className="size-4 text-[var(--bv-blue-text)]" />
            Open external link?
          </DialogTitle>
          <DialogDescription>You're about to visit an external website.</DialogDescription>
        </DialogHeader>
        <div className="bg-muted text-foreground overflow-hidden rounded-lg px-3 py-2 font-mono text-xs break-all">
          {url}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={copy}>
            <Copy aria-hidden className="size-3.5" />
            {copied ? "Copied" : "Copy link"}
          </Button>
          <Button
            type="button"
            onClick={() => {
              // onConfirm opens the tab but does NOT dismiss (streamdown's own
              // modal wraps it the same way) — close it ourselves so the scrim
              // doesn't stay up over the viewport (P20 BRO-1589).
              onConfirm();
              onClose();
            }}
          >
            <ExternalLink aria-hidden className="size-3.5" />
            Open link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
