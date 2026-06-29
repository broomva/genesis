"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart, type UIMessage } from "ai";
import { ArrowUp, PanelLeft, Paperclip, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";

import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { LinkSafetyDialog, type LinkSafetyDialogProps } from "@/components/link-safety-dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { ThinkingIndicator } from "@/components/thinking-indicator";
import { Button } from "@/components/ui/button";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EFFORT_OPTIONS, MODEL_OPTIONS, effortToBody, modelToBody } from "@/lib/chat-options";
import { parseSlash, slashHelpText } from "@/lib/slash";
import { resetThread } from "@/lib/threads";

// Inline text/code attachments into the prompt (BRO-1576). `claude -p` takes no
// inline images, so only text-ish files are inlined as fenced blocks; anything
// else is noted (not silently dropped). PromptInput exposes each file as a
// FileUIPart with a blob: URL, so fetch().text() decodes it client-side. The
// `accept`/`TEXT_FILE_RE` split is intentional: TEXT_FILE_RE is the single source
// of truth for what gets inlined (OS MIME for code files is unreliable —
// .ts→video/mp2t, .json→application/json — so we do NOT gate the picker on it).
const TEXT_FILE_RE =
  /\.(md|markdown|txt|text|json|jsonl|ya?ml|toml|ini|env|csv|tsv|tsx?|jsx?|mjs|cjs|py|rs|go|rb|java|c|h|cpp|cs|php|sh|bash|zsh|sql|css|scss|html?|xml|svg|log|diff|patch)$/i;

// Cap inlined content so a large log/CSV can't blow the prompt token budget.
const MAX_INLINE_BYTES = 100_000;

async function inlineAttachments(files: readonly FileUIPart[]): Promise<string> {
  if (files.length === 0) return "";
  const blocks = await Promise.all(
    files.map(async (f) => {
      const name = f.filename ?? "attachment";
      const isText = (f.mediaType ?? "").startsWith("text/") || TEXT_FILE_RE.test(name);
      if (!isText) {
        return `\n\n[attachment "${name}" (${f.mediaType || "binary"}) omitted (only text/code files are inlined on this deployment)]`;
      }
      try {
        let content = await (await fetch(f.url)).text();
        let truncated = "";
        if (content.length > MAX_INLINE_BYTES) {
          content = content.slice(0, MAX_INLINE_BYTES);
          truncated = `\n… [truncated to ${MAX_INLINE_BYTES.toLocaleString()} chars]`;
        }
        return `\n\nAttached file \`${name}\`:\n\`\`\`\n${content}${truncated}\n\`\`\``;
      } catch {
        return `\n\n[attachment "${name}" could not be read]`;
      }
    }),
  );
  return blocks.join("");
}

// Pull the rendered text out of a UIMessage's parts[] (AI SDK v6 shape).
function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("");
}

// The reasoning INDICATOR note (BRO-1574) — joined from reasoning parts. Empty
// when the turn did no extended thinking (effort off / low).
function messageReasoning(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "reasoning")
    .map((part) => (part as { text: string }).text)
    .join("");
}

// Render streamdown's external-link confirmation through our DS Dialog so it
// portals to document.body and escapes the scroller's fixed-positioning
// containing blocks (BRO-1589). Module-level so the config object is stable.
const LINK_SAFETY = {
  enabled: true,
  renderModal: (props: LinkSafetyDialogProps) => <LinkSafetyDialog {...props} />,
};

// Empty-state starter prompts (BRO-1577) — tappable, send immediately.
const STARTERS: readonly string[] = [
  "What can you help me with?",
  "Summarize the current state of this workspace",
  "Run the test suite and report failures",
  "What changed in the last commit?",
];

// Three-dot "thinking" loader for the gap before the first token (BRO-1577) —
// replaces the bare "…". Per-dot delay staggers the pulse; reduced-motion safe.
function ChatLoader() {
  // <output> has the implicit ARIA role "status" — semantic element instead of a
  // span+role="status" (biome a11y/useSemanticElements; this slipped through to
  // main red in #36/#37 because piping the local biome check through `tail`
  // masked its exit code — fixed forward here, BRO-1582).
  return (
    <output
      className="text-muted-foreground inline-flex items-center gap-1 py-1"
      aria-label="Thinking"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="loader-dot inline-block size-1.5 rounded-full bg-current"
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </output>
  );
}

// The running signal — the DS tidepool dot + a quiet, shimmering label. Idle is
// silent (calm is load-bearing — motion encodes presence, not urgency). Errors
// read in the danger hue, no dot.
function RunningStatus({ status }: { status: ReturnType<typeof useChat>["status"] }) {
  if (status === "error") {
    return (
      <span role="alert" className="text-[var(--bv-danger)] text-xs">
        Something went wrong
      </span>
    );
  }
  const busy = status === "submitted" || status === "streaming";
  if (!busy) return null;
  return (
    <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
      <span className="bv-dot-live" aria-hidden />
      <span className="shimmer text-[var(--bv-blue-text)]">
        {status === "streaming" ? "Responding" : "Thinking"}
      </span>
    </span>
  );
}

/** One chat thread. Remounted by the parent with a `key={threadId}`, so `useChat`
 *  is constructed fresh per thread with the right `id` (→ engine threadId routing)
 *  and hydrated `initialMessages`. `onActivity` fires when a turn finishes so the
 *  parent can refresh the thread list (a brand-new thread appears after its first
 *  reply). `onMenuClick` opens the drawer on mobile. */
export function ChatView({
  threadId,
  initialMessages,
  onActivity,
  onMenuClick,
  onNewThread,
  model,
  effort,
  onModelChange,
  onEffortChange,
}: {
  threadId: string;
  initialMessages: UIMessage[];
  onActivity: () => void;
  onMenuClick: () => void;
  /** Start a brand-new thread (the `/new` slash command). */
  onNewThread: () => void;
  /** Selected model + effort (owned by the parent so they survive ChatView's
   *  per-thread remount); passed per-turn on the send body. */
  model: string;
  effort: string;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
}) {
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat" }), []);
  const { messages, sendMessage, status, error, stop } = useChat({
    id: threadId,
    messages: initialMessages,
    transport,
    onFinish: onActivity,
  });
  // Ephemeral composer feedback (slash-command result / errors), shown above the input.
  const [notice, setNotice] = useState<string | null>(null);

  const busy = status === "submitted" || status === "streaming";

  // Send a turn with the current model/effort selection. Shared by the composer
  // and the empty-state suggestion chips (BRO-1577).
  function send(text: string) {
    if (!text.trim()) return;
    setNotice(null);
    void sendMessage(
      { text },
      { body: { model: modelToBody(model), effort: effortToBody(effort) } },
    );
  }

  // PromptInput owns the textarea state + clears on submit. While a turn is in
  // flight the submit control is a STOP button (status drives the icon), so a
  // submit during streaming aborts instead of double-sending.
  async function handleSubmit(message: PromptInputMessage) {
    if (busy) {
      stop();
      return;
    }
    const raw = message.text?.trim() ?? "";
    const files = message.files ?? [];

    // A `/`-prefixed message is a local command, not an agent turn (BRO-1576).
    const command = files.length === 0 ? parseSlash(raw) : null;
    if (command === "new") {
      setNotice(null);
      onNewThread();
      return;
    }
    if (command === "reset") {
      setNotice("Resetting the agent's memory for this thread…");
      setNotice(
        (await resetThread(threadId)) ? "Agent memory reset for this thread." : "Reset failed.",
      );
      return;
    }
    if (command === "help") {
      setNotice(slashHelpText());
      return;
    }

    send(raw + (await inlineAttachments(files)));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-border flex shrink-0 items-center gap-3 border-b px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="md:hidden [@media(pointer:coarse)]:size-11"
          onClick={onMenuClick}
          aria-label="Open conversations"
        >
          <PanelLeft className="size-4" />
        </Button>
        <span className="text-foreground text-[0.95rem] font-medium tracking-tight">Genesis</span>
        <span className="text-muted-foreground hidden text-sm sm:inline">agent chat</span>
        <div className="ml-auto flex items-center gap-2">
          <RunningStatus status={status} />
          <ThemeToggle />
        </div>
      </header>

      <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport className="px-4">
            <MessageScrollerContent className="mx-auto flex w-full max-w-2xl flex-col gap-5 py-6">
              {messages.length === 0 ? (
                <div className="message-in flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
                  <p className="text-foreground text-[1.375rem] font-semibold">
                    Start a conversation
                  </p>
                  <p className="text-muted-foreground max-w-sm text-sm">
                    Message the agent, or pick a starting point.
                  </p>
                  <Suggestions className="mt-2 justify-center">
                    {STARTERS.map((s) => (
                      <Suggestion key={s} suggestion={s} onClick={send} />
                    ))}
                  </Suggestions>
                </div>
              ) : (
                messages.map((message) => {
                  const isUser = message.role === "user";
                  const text = messageText(message);
                  const reasoning = isUser ? "" : messageReasoning(message);
                  return (
                    <MessageScrollerItem
                      key={message.id}
                      messageId={message.id}
                      scrollAnchor={isUser}
                      className="message-in flex flex-col"
                    >
                      {isUser ? (
                        // DS user bubble — soft cool-gray fill, asymmetric radius
                        // (flat bottom-right corner), right-aligned. Never ink-filled.
                        <div className="bg-[var(--bv-canvas-soft-2)] text-foreground ml-auto max-w-[78%] self-end rounded-[1.5rem_1.5rem_0.375rem_1.5rem] px-[18px] py-2.5 text-[0.95rem] leading-relaxed whitespace-pre-wrap">
                          {text}
                        </div>
                      ) : (
                        // DS assistant — plain ink text flowing on the canvas, no
                        // bubble. The reasoning chip (if any) sits above it.
                        <div className="min-w-0 max-w-full">
                          {reasoning ? <ThinkingIndicator note={reasoning} /> : null}
                          {text ? (
                            // streamdown parses INCOMPLETE markdown so partial
                            // fences/lists/bold don't break mid-stream (BRO-1566).
                            <Streamdown
                              className="text-foreground text-[0.95rem] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                              isAnimating={status === "streaming"}
                              animated
                              linkSafety={LINK_SAFETY}
                            >
                              {text}
                            </Streamdown>
                          ) : busy ? (
                            <ChatLoader />
                          ) : null}
                        </div>
                      )}
                    </MessageScrollerItem>
                  );
                })
              )}
              {error ? (
                <div role="alert" className="text-[var(--bv-danger)] text-sm">
                  {error.message}
                </div>
              ) : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" />
        </MessageScroller>
      </MessageScrollerProvider>

      {/* No top divider — the composer floats with its frosted-blue halo, the one
          dramatic depth cue. Messages blur behind the glass as they scroll under. */}
      <footer className="shrink-0 px-4 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-2xl">
          {notice ? (
            <div className="text-muted-foreground border-border mb-2 flex items-start justify-between gap-2 rounded-xl border px-3 py-2 text-xs whitespace-pre-line">
              <span>{notice}</span>
              <button
                type="button"
                onClick={() => setNotice(null)}
                aria-label="Dismiss"
                className="hover:text-foreground -m-1 inline-flex shrink-0 items-center justify-center rounded-md p-1 transition-colors [@media(pointer:coarse)]:size-11"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ) : null}
          <TooltipProvider>
            <PromptInput
              onSubmit={handleSubmit}
              multiple
              onError={(e) => setNotice(e.message)}
              className="bv-composer w-full"
            >
              <PromptInputBody>
                <PromptInputTextarea
                  // px-2.5 aligns the text with the toolbar (both sit ~18px from
                  // the capsule edge, clear of the 28px rounded corners) — BRO-1589.
                  className="px-2.5"
                  placeholder="Message the agent… (/help for commands)"
                  aria-label="Message the agent"
                />
              </PromptInputBody>
              <PromptInputFooter>
                <PromptInputTools>
                  <PromptInputActionMenu>
                    <PromptInputActionMenuTrigger aria-label="Attach files">
                      <Paperclip className="size-4" />
                    </PromptInputActionMenuTrigger>
                    <PromptInputActionMenuContent>
                      <PromptInputActionAddAttachments label="Attach text files" />
                    </PromptInputActionMenuContent>
                  </PromptInputActionMenu>
                  <PromptInputSelect value={model} onValueChange={onModelChange}>
                    <PromptInputSelectTrigger aria-label="Model">
                      <PromptInputSelectValue />
                    </PromptInputSelectTrigger>
                    <PromptInputSelectContent>
                      {MODEL_OPTIONS.map((o) => (
                        <PromptInputSelectItem key={o.value} value={o.value}>
                          {o.label}
                        </PromptInputSelectItem>
                      ))}
                    </PromptInputSelectContent>
                  </PromptInputSelect>
                  <PromptInputSelect value={effort} onValueChange={onEffortChange}>
                    <PromptInputSelectTrigger aria-label="Effort">
                      <PromptInputSelectValue />
                    </PromptInputSelectTrigger>
                    <PromptInputSelectContent>
                      {EFFORT_OPTIONS.map((o) => (
                        <PromptInputSelectItem key={o.value} value={o.value}>
                          {o.label}
                        </PromptInputSelectItem>
                      ))}
                    </PromptInputSelectContent>
                  </PromptInputSelect>
                </PromptInputTools>
                {/* DS send — a circular primary-fill button with the DS up-arrow at
                  rest (the button inherits the ink-hover lighten from the default
                  variant). The component swaps in its own spinner/stop/error glyphs
                  for the in-flight states, so only the idle icon is overridden.
                  onStop → during a stream the button becomes type=button and aborts
                  directly (no form submit/reset), so text typed mid-stream isn't
                  wiped (P20 BRO-1573). handleSubmit's busy-guard is the Enter-key
                  fallback. */}
                <PromptInputSubmit status={status} onStop={stop} className="size-9 rounded-full">
                  {status === "ready" ? <ArrowUp className="size-4" /> : undefined}
                </PromptInputSubmit>
              </PromptInputFooter>
            </PromptInput>
          </TooltipProvider>
        </div>
      </footer>
    </div>
  );
}
