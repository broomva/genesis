"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { PanelLeft } from "lucide-react";
import { useMemo } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";

import {
  PromptInput,
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
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Message, MessageContent } from "@/components/ui/message";
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
import { cn } from "@/lib/utils";

// Pull the rendered text out of a UIMessage's parts[] (AI SDK v6 shape).
function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("");
}

function StatusPill({ status }: { status: ReturnType<typeof useChat>["status"] }) {
  const busy = status === "submitted" || status === "streaming";
  const label =
    status === "streaming"
      ? "streaming"
      : status === "submitted"
        ? "thinking"
        : status === "error"
          ? "error"
          : "idle";
  return (
    <span
      className={cn(
        "rounded-full border px-2.5 py-0.5 font-mono text-xs",
        busy && "shimmer border-[var(--ai-blue)]/40 text-[var(--ai-blue)]",
        status === "error" && "border-destructive/50 text-destructive",
        !busy && status !== "error" && "border-border text-muted-foreground",
      )}
    >
      {label}
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
  model,
  effort,
  onModelChange,
  onEffortChange,
}: {
  threadId: string;
  initialMessages: UIMessage[];
  onActivity: () => void;
  onMenuClick: () => void;
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

  const busy = status === "submitted" || status === "streaming";

  // PromptInput owns the textarea state + clears on submit. While a turn is in
  // flight the submit control is a STOP button (status drives the icon), so a
  // submit during streaming aborts instead of double-sending.
  function handleSubmit(message: PromptInputMessage) {
    if (busy) {
      stop();
      return;
    }
    const text = message.text?.trim();
    if (!text) return;
    void sendMessage(
      { text },
      { body: { model: modelToBody(model), effort: effortToBody(effort) } },
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-border flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="md:hidden"
          onClick={onMenuClick}
          aria-label="Open conversations"
        >
          <PanelLeft className="size-4" />
        </Button>
        <span className="font-mono text-sm font-semibold tracking-tight text-[var(--ai-blue)]">
          Genesis
        </span>
        <span className="text-muted-foreground hidden font-mono text-xs sm:inline">agent chat</span>
        <div className="ml-auto">
          <StatusPill status={status} />
        </div>
      </header>

      <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport className="px-4">
            <MessageScrollerContent className="mx-auto w-full max-w-2xl py-6">
              {messages.length === 0 ? (
                <div className="text-muted-foreground py-16 text-center font-mono text-sm">
                  Message the agent to begin.
                </div>
              ) : (
                messages.map((message) => {
                  const isUser = message.role === "user";
                  const text = messageText(message);
                  return (
                    <MessageScrollerItem
                      key={message.id}
                      messageId={message.id}
                      scrollAnchor={isUser}
                    >
                      <Message align={isUser ? "end" : "start"}>
                        <MessageContent>
                          <Bubble
                            variant={isUser ? "default" : "muted"}
                            align={isUser ? "end" : "start"}
                          >
                            {isUser ? (
                              <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
                            ) : (
                              <BubbleContent>
                                {text ? (
                                  // streamdown parses INCOMPLETE markdown so partial
                                  // fences/lists/bold don't break mid-stream (BRO-1566).
                                  <Streamdown
                                    className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                                    isAnimating={status === "streaming"}
                                    animated
                                  >
                                    {text}
                                  </Streamdown>
                                ) : busy ? (
                                  "…"
                                ) : null}
                              </BubbleContent>
                            )}
                          </Bubble>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  );
                })
              )}
              {error ? (
                <div className="text-destructive mt-4 font-mono text-xs">{error.message}</div>
              ) : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" />
        </MessageScroller>
      </MessageScrollerProvider>

      <footer className="border-border bg-background shrink-0 border-t px-4 py-3">
        <TooltipProvider>
          <PromptInput onSubmit={handleSubmit} className="mx-auto w-full max-w-2xl">
            <PromptInputBody>
              <PromptInputTextarea placeholder="Message the agent…" />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
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
              <PromptInputSubmit status={status} />
            </PromptInputFooter>
          </PromptInput>
        </TooltipProvider>
      </footer>
    </div>
  );
}
