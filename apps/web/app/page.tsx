"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { ArrowUp } from "lucide-react";
import { useState } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";

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
import { cn } from "@/lib/utils";

// Pull the rendered text out of a UIMessage's parts[] (AI SDK v6 shape).
// The genesis ChatSdkConnector folds phase events into the same text stream
// (it does NOT emit separate data parts), so text is all we render here.
// TODO(phase-markers): if the connector starts emitting genesis `phase` events
// as AI-SDK data parts, render them as <Marker> rows. As of this slice the
// upstream stream carries only start/text-*/finish, so there is nothing to map.
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

export default function ChatPage() {
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });
  const [input, setInput] = useState("");

  const busy = status === "submitted" || status === "streaming";

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void sendMessage({ text });
  }

  return (
    <div className="bg-background text-foreground flex h-dvh flex-col">
      <header className="border-border flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <span className="font-mono text-sm font-semibold tracking-tight text-[var(--ai-blue)]">
          Genesis
        </span>
        <span className="text-muted-foreground font-mono text-xs">agent chat</span>
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
                                  // fences/lists/bold don't break mid-stream. Themed via
                                  // the shadcn/arcan-glass CSS vars in globals.css; the
                                  // @source line there makes Tailwind emit its utilities.
                                  // No code/math/mermaid plugins → pure-JS pipeline, no
                                  // WASM in the standalone trace. First/last margins are
                                  // collapsed so bubble padding stays even.
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
        <form onSubmit={onSubmit} className="mx-auto flex w-full max-w-2xl items-end gap-2">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Message the agent…"
            aria-label="Message the agent"
            className={cn(
              "bg-card border-border placeholder:text-muted-foreground flex-1 rounded-lg border px-3.5 py-2.5 text-sm",
              "focus-visible:border-ring focus-visible:ring-ring/40 outline-none focus-visible:ring-2",
            )}
          />
          <Button
            type="submit"
            size="icon"
            disabled={busy || input.trim().length === 0}
            aria-label="Send message"
          >
            <ArrowUp className="size-4" />
          </Button>
        </form>
      </footer>
    </div>
  );
}
