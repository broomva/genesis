"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart, type UIMessage } from "ai";
import { ArrowUp, FolderGit2, PanelLeft, Paperclip, X } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";

import { ContextMeter, type ContextMeterData } from "@/components/ai-elements/context-meter";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionAddScreenshot,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputProvider,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import { SkillPart, ToolPart } from "@/components/ai-elements/tool";
import { ComposerAttachments, MessageAttachments } from "@/components/attachments";
import { FilesChanged, filesChangedFromParts } from "@/components/files-changed";
import { LinkSafetyDialog, type LinkSafetyDialogProps } from "@/components/link-safety-dialog";
import { CopyButton, MessageActions, RunTimer } from "@/components/message-actions";
import { QuestionCard } from "@/components/question-card";
import { SessionLauncher } from "@/components/session-launcher";
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
import {
  contextWindowFor,
  effortOptionsFor,
  effortToBody,
  engineShowsEffort,
  engineShowsModel,
  engineToBody,
  modelIsSpawnPinned,
  modelOptionsFor,
  modelToBody,
  sanitizeEffortFor,
  sanitizeModelFor,
  sanitizeWorktreeFor,
  workspaceToBody,
  worktreeToBody,
} from "@/lib/chat-options";
import { recallDirection, recallStep } from "@/lib/input-history";
import type { ThemeChoice } from "@/lib/preferences";
import { parseSlash, slashHelpText } from "@/lib/slash";
import type { RunMode } from "@/lib/thread-status";
import type { ThreadPhase } from "@/lib/threads";
import { type MessageMetadata, resetThread } from "@/lib/threads";
import { useComposerAutoHide } from "@/lib/use-composer-autohide";
import { useThreadReconcile } from "@/lib/use-thread-reconcile";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/lib/workspaces";

// Multimodal attachments (BRO-1706): the composer sends attached files as native
// AI-SDK file parts (data: URLs). The engine materializes them into the agent's
// working directory and the agent Reads them (images/PDFs/text — Claude's Read is
// natively multimodal). No more client-side text-only inlining: the byte-exact file
// reaches the agent, so images and binaries "just work". Per-file size + count are
// bounded on the PromptInput below (with user feedback) and re-capped server-side.

// Pull the rendered text out of a UIMessage's parts[] (AI SDK v6 shape). Used for
// the user bubble + input-history recall; assistant messages render their parts in
// order (text · reasoning · tool) via AssistantBody (BRO-1607).
function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
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

// Render one assistant message's parts IN ORDER (BRO-1607): reasoning indicator,
// answer text, and tool/skill blocks interleave exactly as the agent produced
// them — "say X · run a tool · say Y" — instead of collapsing to the final text.
// Only the last text part animates while streaming; an empty in-flight message
// (no parts yet) shows the three-dot loader.
function AssistantBody({
  message,
  streaming,
  busy,
  isLast,
  onRetry,
  onAnswer,
  showReasoning,
}: {
  message: UIMessage;
  streaming: boolean;
  busy: boolean;
  isLast: boolean;
  onRetry?: () => void;
  onAnswer?: (text: string) => void;
  /** User preference (BRO-1618) — hide the reasoning panel when off. */
  showReasoning: boolean;
}) {
  const parts = message.parts;
  let lastTextIdx = -1;
  parts.forEach((p, i) => {
    if (p.type === "text") lastTextIdx = i;
  });
  let rendered = 0;
  const nodes = parts.map((part, i) => {
    const key = `${message.id}-p${i}`;
    if (part.type === "reasoning") {
      if (!showReasoning) return null;
      const note = (part as { text: string }).text;
      if (!note) return null;
      rendered++;
      return <ThinkingIndicator key={key} note={note} />;
    }
    if (part.type === "text") {
      const t = (part as { text: string }).text;
      if (!t) return null;
      rendered++;
      // streamdown parses INCOMPLETE markdown so partial fences/lists/bold don't
      // break mid-stream (BRO-1566); only the last text part is still growing.
      return (
        <Streamdown
          key={key}
          className="text-foreground text-[0.95rem] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          isAnimating={streaming && i === lastTextIdx}
          animated
          linkSafety={LINK_SAFETY}
        >
          {t}
        </Streamdown>
      );
    }
    if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      rendered++;
      // Narrowed by the type check — a tool/dynamic-tool UIMessagePart.
      const p = part as Parameters<typeof ToolPart>[0]["part"];
      const name = p.type === "dynamic-tool" ? p.toolName : p.type.split("-").slice(1).join("-");
      // AskUserQuestion renders as an answer card (BRO-1611), interactive only
      // while it's the awaiting turn (last message, agent idle).
      if (name === "AskUserQuestion" || name === "ask_user_question") {
        return (
          <QuestionCard
            key={key}
            input={p.input}
            interactive={isLast && !busy && !!onAnswer}
            onAnswer={onAnswer ?? (() => {})}
          />
        );
      }
      // A Skill activation is a first-class event (BRO-1625) — premium badge,
      // distinct from a generic tool card. The Skill tool input is {skill, args}.
      // Case-insensitive to match a "skill"/"Skill" spelling either way (mirrors
      // the AskUserQuestion alternate-spelling handling above) — CodeRabbit #64.
      if (name.toLowerCase() === "skill") {
        return <SkillPart key={key} part={p} />;
      }
      return <ToolPart key={key} part={p} />;
    }
    return null;
  });
  // Run time (persisted, BRO-1610) + copy/retry, revealed on hover via the `group`.
  const meta = message.metadata as MessageMetadata | undefined;
  // Files the turn's Edit/Write tools touched (BRO-1612) — the agent's work, legible.
  const files = filesChangedFromParts(message.parts);
  return (
    <div className="group min-w-0 max-w-full">
      {nodes}
      {rendered === 0 && busy ? <ChatLoader /> : null}
      {files.length > 0 ? <FilesChanged files={files} /> : null}
      {rendered > 0 ? (
        <MessageActions
          text={messageText(message)}
          durationMs={meta?.durationMs}
          onRetry={onRetry}
          canRetry={!busy}
        />
      ) : null}
    </div>
  );
}

// A user turn — the DS cool-gray bubble (asymmetric radius, right-aligned) plus a
// copy affordance that mirrors the assistant's (BRO-1705). The `group` reveals Copy
// on hover; it's always shown on touch. The bubble keeps its max-width + asymmetric
// radius; alignment moves to the wrapper's `items-end` so the copy row sits neatly
// below-right (mirroring the assistant's below-left copy/retry row).
function UserMessage({ message }: { message: UIMessage }) {
  const text = messageText(message);
  return (
    <div className="group flex flex-col items-end">
      {/* Attached images/files render inline above the bubble (BRO-1706). */}
      <MessageAttachments parts={message.parts} className="mb-1" />
      <div className="bg-[var(--bv-canvas-soft-2)] text-foreground max-w-[78%] rounded-[1.5rem_1.5rem_0.375rem_1.5rem] px-[18px] py-2.5 text-[0.95rem] leading-relaxed whitespace-pre-wrap">
        {text}
      </div>
      <div className="mt-1 flex items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100">
        <CopyButton text={text} label="Copy message" />
      </div>
    </div>
  );
}

// The running signal — the DS tidepool dot + a quiet, shimmering label. Idle is
// silent (calm is load-bearing — motion encodes presence, not urgency). Driven by
// the reconciled run MODE (BRO-1640) so a dropped stream reads as a recoverable
// "Working / Reconnecting", not a dead-end error:
//   streaming    → live SSE (Thinking / Responding)
//   working      → turn still running server-side, no live stream (backgrounded +
//                  returned, or opened a running thread) — same calm live signal
//   reconnecting → briefly re-syncing the durable result (calm, not danger)
//   error        → a genuinely blocked turn — danger hue + a Retry affordance
//   idle         → silent
function RunSignal({
  mode,
  liveStatus,
  onRetry,
}: {
  mode: RunMode;
  liveStatus: ReturnType<typeof useChat>["status"];
  onRetry: () => void;
}) {
  if (mode === "error") {
    return (
      <span role="alert" className="flex items-center gap-1.5 text-xs">
        <span className="text-[var(--bv-danger)]">Something went wrong</span>
        <button
          type="button"
          onClick={onRetry}
          className="text-[var(--bv-blue-text)] underline underline-offset-2 hover:opacity-80"
        >
          Retry
        </button>
      </span>
    );
  }
  if (mode === "reconnecting") {
    return (
      <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <span className="bv-dot-live" aria-hidden />
        <span className="shimmer">Reconnecting…</span>
      </span>
    );
  }
  if (mode === "streaming" || mode === "working") {
    // "working" = the turn is running server-side but the live token stream is gone;
    // show the same calm presence signal + timer (the result lands when it settles).
    const label =
      mode === "working" ? "Working" : liveStatus === "streaming" ? "Responding" : "Thinking";
    return (
      <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <span className="bv-dot-live" aria-hidden />
        <span className="shimmer text-[var(--bv-blue-text)]">{label}</span>
        {/* Live run-time (BRO-1610) — ticks while the turn is in flight (live or reconciled). */}
        <RunTimer active />
      </span>
    );
  }
  return null;
}

// Terminal-style input-history recall (BRO-1598). ArrowUp at caret-start recalls
// the previous user message into the composer; once recalling, ArrowUp/ArrowDown
// walk the history (Down off the top restores the saved draft). Recall writes
// through the PromptInput controller, so it only works inside a PromptInputProvider.
// The index resets when the user types (onChange) or when a NEW turn is sent in
// this thread (history.length grows). Switching THREADS resets via ChatView's
// key={activeThreadId} remount — this hook is reconstructed fresh — NOT the
// length effect (lengths can coincide across threads).
function useInputHistory(history: readonly string[], setInput: (v: string) => void) {
  const idxRef = useRef(-1); // -1 = live draft (not recalling)
  const draftRef = useRef(""); // the in-progress draft, saved on entering recall
  const [announce, setAnnounce] = useState(""); // aria-live cue for screen readers

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on length, not array identity
  useEffect(() => {
    idxRef.current = -1;
    setAnnounce("");
  }, [history.length]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing || history.length === 0) return;
      const ta = e.currentTarget;
      const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
      const recalling = idxRef.current >= 0;
      const dir = recallDirection(e.key, atStart, recalling);
      if (!dir) return;
      e.preventDefault();
      if (!recalling) draftRef.current = ta.value; // entering recall: save the draft
      const { index, text } = recallStep(history, idxRef.current, dir);
      idxRef.current = index;
      if (index < 0) {
        setInput(draftRef.current); // exited recall: restore the in-progress draft
        setAnnounce("Returned to draft");
      } else {
        setInput(text);
        // index 0 = most recent → numbered newest-last for a human ("3 of 3").
        setAnnounce(`Recalled message ${history.length - index} of ${history.length}`);
      }
    },
    [history, setInput],
  );

  const onChange = useCallback(() => {
    idxRef.current = -1; // any real edit drops out of recall
    setAnnounce("");
  }, []);

  return { onKeyDown, onChange, announce };
}

// The composer textarea wired for input-history recall (BRO-1598). Renders inside
// a PromptInputProvider so it can write recalled text through the controller.
// `history` is the thread's user-message texts, oldest → newest.
function RecallTextarea({ history }: { history: readonly string[] }) {
  const { textInput } = usePromptInputController();
  const { onKeyDown, onChange, announce } = useInputHistory(history, textInput.setInput);
  return (
    <>
      <PromptInputTextarea
        // px-2.5 aligns the text with the toolbar (clear of the 28px corners, BRO-1589).
        className="px-2.5"
        placeholder="Message the agent… (/help for commands)"
        aria-label="Message the agent"
        // Stable hook for the launcher's Start-session focus + E2E drivability (BRO-1634).
        data-testid="composer-input"
        onKeyDown={onKeyDown}
        onChange={onChange}
      />
      {/* Announce recall to assistive tech — a programmatic value swap isn't
          reliably read otherwise. <output> is an implicit aria-live=polite status. */}
      <output className="sr-only">{announce}</output>
    </>
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
  onOpenFiles,
  onNewThread,
  model,
  effort,
  onModelChange,
  onEffortChange,
  showReasoning,
  theme,
  onThemeChange,
  engine,
  availableEngines,
  onEngineChange,
  workspace,
  workspaces,
  onWorkspaceChange,
  worktree,
  onWorktreeChange,
  title,
  boundWorkspaceName,
  boundNoWorktree,
  branch,
  serverPhase,
}: {
  threadId: string;
  initialMessages: UIMessage[];
  onActivity: () => void;
  onMenuClick: () => void;
  /** Open the workspace filesystem browser slide-over (BRO-1666). */
  onOpenFiles: () => void;
  /** Start a brand-new thread (the `/new` slash command). */
  onNewThread: () => void;
  /** Selected model + effort (owned by the parent so they survive ChatView's
   *  per-thread remount); passed per-turn on the send body. */
  model: string;
  effort: string;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
  /** Render-gate for the reasoning panel (BRO-1618 user preference). */
  showReasoning: boolean;
  /** Theme (BRO-1618) — the header quick-toggle is controlled by the prefs hook
   *  so it never drifts from the settings sheet. */
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
  /** Selected agent engine (BRO-1620) — sent per turn (sticky on the server's
   *  first turn). Interactive ignores per-turn model/effort, so those selectors
   *  are hidden when it's active. */
  engine: string;
  /** Backend-advertised runnable engines (BRO-1622) — null degrades OPEN. Passed to
   *  the launcher card so its engine picker gates like the settings sheet's. */
  availableEngines: string[] | null;
  /** Change the (global) engine pref from the launcher card (BRO-1657). */
  onEngineChange: (value: string) => void;
  /** Selected workspace id (BRO-1627) — the repo the thread runs in, sent on the
   *  first turn (sticky at session create). Locked once the thread has run. */
  workspace: string;
  /** The selectable workspaces; the picker self-hides when there's ≤1. */
  workspaces: Workspace[];
  onWorkspaceChange: (value: string) => void;
  /** Root/worktree posture for a new thread (BRO-1656/1657) — "auto"|"root"|
   *  "worktree", sent on the first turn (sticky). Clamped to the selected
   *  workspace's capability before it rides the wire. */
  worktree: string;
  onWorktreeChange: (value: string) => void;
  /** The thread's title (BRO-1662) — shown as the header session name; absent on a
   *  never-run thread (→ "New session" until the first turn auto-derives one). */
  title?: string;
  /** The thread's BOUND workspace display name (BRO-1662, ThreadSummary.workspaceName)
   *  — authoritative for the header subtitle once the thread has run (stable across a
   *  workspace-list reload or a rename). Absent on a never-run thread → the header
   *  falls back to the pending selection's name from the live list. */
  boundWorkspaceName?: string;
  /** The thread's BOUND worktree posture (BRO-1662) — true = root, false = worktree.
   *  Drives the header subtitle once the thread has run; absent → the header shows the
   *  pending launcher choice instead. */
  boundNoWorktree?: boolean;
  /** The thread's cwd git branch (BRO-1664) — preferred in the header subtitle
   *  (`<workspace> · <branch>`) once the thread has run; absent → falls back to the
   *  root/worktree posture. */
  branch?: string;
  /** The active thread's last-known SERVER phase (BRO-1640), from the parent's
   *  thread-list poll. Seeds the reconcile mode so opening an already-running thread
   *  (or returning to one after a dropped stream) shows "Working" without waiting for
   *  the first status fetch. Absent on a never-run thread. */
  serverPhase?: ThreadPhase;
}) {
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat" }), []);
  const { messages, sendMessage, status, error, stop, regenerate, setMessages, clearError } =
    useChat({
      id: threadId,
      messages: initialMessages,
      transport,
      onFinish: onActivity,
    });
  // Stream reconciliation (BRO-1640): a dropped SSE (iOS backgrounding → "Load
  // failed") is recoverable, not a crash. On error / foreground-return this clears
  // the sticky error (un-wedging the composer), reads the server phase, and polls the
  // durable transcript until the turn settles. `mode` drives the run signal.
  const {
    mode: runMode,
    reconnect,
    interrupted,
  } = useThreadReconcile({
    threadId,
    liveStatus: status,
    error,
    initialPhase: serverPhase ?? null,
    setMessages,
    clearError,
  });
  // Ephemeral composer feedback (slash-command result / errors), shown above the input.
  const [notice, setNotice] = useState<string | null>(null);

  const busy = status === "submitted" || status === "streaming";

  // ── Mobile composer auto-hide (BRO-1626) ──
  // The composer is a bottom OVERLAY over the scroller; on mobile it slides away
  // when scrolling toward older messages (freeing reading space) and returns
  // toward the newest. `stageRef` is the positioning context that also carries
  // `--composer-h` (the live overlay height) so the scroller reserves matching
  // bottom clearance and the scroll-to-end button rides above the composer.
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLElement>(null);
  const [composerFocused, setComposerFocused] = useState(false);

  // Resolve the scroll viewport for the auto-hide hook (declared before the hook
  // so the ref is populated first). Resolving by data-slot avoids depending on
  // the message-scroller primitive forwarding a ref.
  useEffect(() => {
    const node =
      stageRef.current?.querySelector<HTMLDivElement>('[data-slot="message-scroller-viewport"]') ??
      null;
    viewportRef.current = node;
    if (!node && process.env.NODE_ENV !== "production") {
      console.warn(
        "[composer-autohide] scroll viewport not found ([data-slot=message-scroller-viewport]); auto-hide is disabled.",
      );
    }
  }, []);

  // Keep `--composer-h` in lockstep with the live composer height (it grows with a
  // multi-line draft) so the last message never hides behind the overlay.
  useEffect(() => {
    const el = composerRef.current;
    const stage = stageRef.current;
    if (!el || !stage || typeof ResizeObserver === "undefined") return;
    const sync = () => stage.style.setProperty("--composer-h", `${el.offsetHeight}px`);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Hidden only on mobile, only when scrolling toward older messages, and never
  // while focused / streaming / a notice is up (see the hook's overrides).
  const composerHidden = useComposerAutoHide(viewportRef, {
    focused: composerFocused,
    streaming: busy,
    forceShow: notice !== null,
  });

  // Provider-aware model/effort (BRO-1623). The model/effort prefs are a shared
  // slot, but each engine belongs to a provider (claude vs OpenAI) with its own
  // valid values — so clamp to the engine's provider for display AND for the wire
  // (a claude alias must never reach codex). Clamping at DISPLAY (not overwriting
  // the pref) preserves the other provider's choice across an engine switch.
  const effModel = sanitizeModelFor(model, engine);
  const effEffort = sanitizeEffortFor(effort, engine);
  // Effective worktree posture (BRO-1656/1657): clamp the pref to what the SELECTED
  // workspace can actually host — a nested-repo / global-noWorktree workspace forces
  // Root, so the wire value never lies. `worktreeCapable === false` only; undefined
  // (older engine) stays as chosen (the server still enforces the safety downgrade).
  const worktreeCapable = workspaces.find((w) => w.id === workspace)?.worktreeCapable !== false;
  const effWorktree = sanitizeWorktreeFor(worktree, worktreeCapable);
  // Interactive binds its model at session SPAWN; once the thread has produced an
  // assistant turn the live session exists and the model is locked (BRO-1623).
  const modelLocked = modelIsSpawnPinned(engine) && messages.some((m) => m.role === "assistant");

  // Header session context (BRO-1662) — the workspace + run posture move OUT of the
  // composer toolbar (which they crowded) INTO the header subtitle. Workspace binds
  // at session create; pre-session selection lives in the launcher card, so the
  // composer no longer carries the picker at all.
  // Prefer the thread's BOUND workspace name (ThreadSummary.workspaceName) — it's
  // authoritative + stable even while the live workspace list is still loading or if
  // the workspace was renamed/removed since binding (CodeRabbit, BRO-1662). Fall back
  // to the live list only for a NEW thread (not yet bound → the pending selection).
  const workspaceName = boundWorkspaceName ?? workspaces.find((w) => w.id === workspace)?.name;
  // Run posture for the subtitle: the thread's BOUND value once it has run, else the
  // pending launcher choice (auto → the workspace default the server would pick).
  const runLabel =
    boundNoWorktree !== undefined
      ? boundNoWorktree
        ? "root"
        : "worktree"
      : effWorktree === "worktree"
        ? "worktree"
        : effWorktree === "root"
          ? "root"
          : worktreeCapable
            ? "worktree"
            : "root";
  // Prefer the literal git branch (BRO-1664) once the thread has run — falls back to
  // the root/worktree posture on a never-run thread or a non-git cwd.
  const contextLabel = branch?.trim() ? branch.trim() : runLabel;
  const sessionName = title?.trim() ? title.trim() : "New session";

  // Session usage for the composer context meter (BRO-1597). Sum cost + tokens
  // over assistant turns — live message-metadata and hydrated history both land
  // on `message.metadata` — and take the LATEST assistant usage as the current
  // context-window fill (input + cache = the real prompt size).
  const meterData = useMemo<ContextMeterData>(() => {
    let costUsd = 0;
    let sessionInput = 0;
    let sessionOutput = 0;
    let sessionCacheRead = 0;
    let sessionCacheWrite = 0;
    let latest: MessageMetadata["usage"];
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      const meta = m.metadata as MessageMetadata | undefined;
      if (!meta) continue;
      if (typeof meta.costUsd === "number") costUsd += meta.costUsd;
      if (meta.usage) {
        sessionInput += meta.usage.input;
        sessionOutput += meta.usage.output;
        sessionCacheRead += meta.usage.cacheRead;
        sessionCacheWrite += meta.usage.cacheCreation;
        latest = meta.usage;
      }
    }
    const contextTokens = latest ? latest.input + latest.cacheRead + latest.cacheCreation : 0;
    return {
      contextTokens,
      contextWindow: contextWindowFor(effModel, engine),
      costUsd,
      sessionInput,
      sessionOutput,
      sessionCacheRead,
      sessionCacheWrite,
    };
  }, [messages, effModel, engine]);

  // The thread's user-message texts (oldest → newest) for input-history recall
  // (BRO-1598) — the ArrowUp/ArrowDown stack in the composer.
  const userHistory = useMemo(
    () => messages.filter((m) => m.role === "user").map(messageText),
    [messages],
  );

  // Send a turn with the current model/effort selection. Shared by the composer
  // and the empty-state suggestion chips (BRO-1577). Files (BRO-1706) ride as native
  // AI-SDK file parts so useChat renders them in the bubble AND the engine receives
  // them for materialization.
  function send(text: string, files?: FileUIPart[]) {
    const hasFiles = !!files && files.length > 0;
    if (!text.trim() && !hasFiles) return;
    setNotice(null);
    void sendMessage(hasFiles ? { text, files } : { text }, {
      body: {
        model: modelToBody(effModel),
        // Only send effort for an engine that consumes it (interactive ignores
        // it — persistent session, no per-launch knob) — BRO-1623 P20.
        effort: engineShowsEffort(engine) ? effortToBody(effEffort) : undefined,
        engine: engineToBody(engine),
        // The workspace binds at session create (BRO-1627) — sent every turn but
        // honored only on the first; the server ignores it once bound.
        workspaceId: workspaceToBody(workspace),
        // Worktree posture binds sticky on turn 1 (BRO-1656) — sent every turn but
        // frozen after the first; "auto" omits it (inherit the workspace default).
        worktree: worktreeToBody(effWorktree),
      },
    });
  }

  // Retry affordance for a run-signal error (BRO-1674). Two causes hide behind
  // runMode "error" and need OPPOSITE recovery:
  //   • interrupted (server phase "blocked") — the run was killed mid-turn (a
  //     deploy/crash SIGTERM'd the engine, reconciled → blocked, BRO-1530). The turn
  //     is durably resumable, so Retry RE-DISPATCHES it: regenerate() re-runs the
  //     trailing user message (AI SDK v6 keeps a trailing user message in the
  //     request), which the engine reads as the turn text and continues via
  //     `--resume <agentSessionId>` (BRO-1630). A plain reconcile() only re-reads the
  //     same blocked transcript → the old Retry was a visible no-op.
  //   • transient (dropped stream / engine unconfirmable) — reconcile() refetches the
  //     durable status + transcript; re-dispatching there could double-run a live turn.
  // Self-contained double-run guard (P20): only re-dispatch when the UI is actually
  // in the interrupted-error state. `runMode === "error"` implies no live stream —
  // deriveRunMode returns "streaming" before it ever reaches the blocked→error branch
  // — so this can't double-run a turn that's still live server-side, even in the brief
  // window after regenerate() where `interrupted` (serverPhase "blocked") is still true
  // but a stream has started, or if a future caller wires retryRun outside the banners.
  const retryRun = useCallback(() => {
    if (interrupted && runMode === "error" && messages.length > 0) {
      void regenerate({
        body: {
          model: modelToBody(effModel),
          effort: engineShowsEffort(engine) ? effortToBody(effEffort) : undefined,
          engine: engineToBody(engine),
          workspaceId: workspaceToBody(workspace),
          worktree: worktreeToBody(effWorktree),
        },
      });
      return;
    }
    reconnect();
  }, [
    interrupted,
    runMode,
    messages.length,
    regenerate,
    reconnect,
    effModel,
    effEffort,
    engine,
    workspace,
    effWorktree,
  ]);

  // The launcher's "Start session" (BRO-1657): focus the composer so the user types
  // their first message. Lazy by design — no thread/session is created until that
  // first send, so a configured-but-abandoned launcher leaves no ghost thread.
  const startSession = useCallback(() => {
    const ta = stageRef.current?.querySelector<HTMLTextAreaElement>(
      '[data-testid="composer-input"]',
    );
    ta?.focus();
  }, []);

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

    // Attach-only turn (BRO-1706): default a prompt so the bubble + engine both have
    // text (the engine requires non-empty user text). Files ride as native parts.
    const text = raw || (files.length > 0 ? "Take a look at the attached file(s)." : "");
    send(text, files);
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
        {/* Session identity (BRO-1662) — the thread name + a muted "workspace · posture"
            subtitle, replacing the static "Genesis" label. The workspace context lives
            here now instead of crowding the composer. */}
        <div className="min-w-0 flex-1">
          <p className="text-foreground truncate text-[0.95rem] font-medium leading-tight tracking-tight">
            {sessionName}
          </p>
          {workspaceName ? (
            <p className="text-muted-foreground truncate text-xs leading-tight">
              {workspaceName} · {contextLabel}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RunSignal mode={runMode} liveStatus={status} onRetry={retryRun} />
          {/* Workspace files (BRO-1666) — opens the read-only fs browser slide-over
              for this session's bound workspace. */}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={onOpenFiles}
            aria-label="Browse workspace files"
            data-testid="open-workspace-browser"
            className="[@media(pointer:coarse)]:size-11"
          >
            <FolderGit2 className="size-4" />
          </Button>
          <ThemeToggle theme={theme} onChange={onThemeChange} />
        </div>
      </header>

      <div ref={stageRef} className="relative min-h-0 flex-1">
        <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
          <MessageScroller className="min-h-0">
            <MessageScrollerViewport className="px-4">
              <MessageScrollerContent className="mx-auto flex w-full max-w-2xl flex-col gap-5 pt-6 pb-[calc(var(--composer-h,4.5rem)+1.25rem)]">
                {messages.length === 0 ? (
                  // The Session Launcher (BRO-1657) — the pre-session configurator
                  // card. Surfaces every sticky binding (workspace/engine/model/
                  // effort/worktree) + starters; the bottom composer stays the input.
                  <div className="flex min-h-[60vh] flex-col items-center justify-center">
                    <SessionLauncher
                      workspace={workspace}
                      workspaces={workspaces}
                      onWorkspaceChange={onWorkspaceChange}
                      engine={engine}
                      availableEngines={availableEngines}
                      onEngineChange={onEngineChange}
                      model={effModel}
                      onModelChange={onModelChange}
                      effort={effEffort}
                      onEffortChange={onEffortChange}
                      worktree={effWorktree}
                      onWorktreeChange={onWorktreeChange}
                      onStart={startSession}
                      onStarter={send}
                      starters={STARTERS}
                    />
                  </div>
                ) : (
                  messages.map((message, index) => {
                    const isUser = message.role === "user";
                    const isLast = index === messages.length - 1;
                    return (
                      <MessageScrollerItem
                        key={message.id}
                        messageId={message.id}
                        scrollAnchor={isUser}
                        className="message-in flex flex-col"
                      >
                        {isUser ? (
                          <UserMessage message={message} />
                        ) : (
                          // DS assistant — plain ink text flowing on the canvas, no
                          // bubble; reasoning · text · tool blocks render in order.
                          <AssistantBody
                            message={message}
                            streaming={status === "streaming"}
                            busy={busy}
                            isLast={isLast}
                            showReasoning={showReasoning}
                            onRetry={() =>
                              regenerate({
                                messageId: message.id,
                                body: {
                                  model: modelToBody(effModel),
                                  effort: engineShowsEffort(engine)
                                    ? effortToBody(effEffort)
                                    : undefined,
                                  engine: engineToBody(engine),
                                  workspaceId: workspaceToBody(workspace),
                                  worktree: worktreeToBody(effWorktree),
                                },
                              })
                            }
                            onAnswer={send}
                          />
                        )}
                      </MessageScrollerItem>
                    );
                  })
                )}
                {/* Only a GENUINELY blocked turn surfaces an inline error (BRO-1640):
                    a transient stream drop (background) reconciles silently to
                    Working/Reconnecting instead of dumping "Load failed" here. */}
                {runMode === "error" ? (
                  <div
                    role="alert"
                    className="text-[var(--bv-danger)] flex items-center gap-2 text-sm"
                  >
                    <span>The agent run was interrupted.</span>
                    <button
                      type="button"
                      onClick={retryRun}
                      className="text-[var(--bv-blue-text)] underline underline-offset-2 hover:opacity-80"
                    >
                      Retry
                    </button>
                  </div>
                ) : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton
              direction="end"
              // Sit just above the composer when it's shown; drop to the bottom
              // when it auto-hides (BRO-1628) — otherwise the button stays lifted by
              // the (now-hidden) composer's height and floats mid-screen. The shown
              // fallback agrees with the content's pb-[var(--composer-h,4.5rem)].
              style={{
                bottom: composerHidden
                  ? "calc(0.75rem + env(safe-area-inset-bottom))"
                  : "calc(var(--composer-h, 4.5rem) + 0.5rem)",
                // Ease `bottom` too (BRO-1628 P20) so it rides the composer's slide
                // instead of snapping ~4rem when it hides — additive to the
                // primitive's translate/scale/opacity transition (duration/easing
                // still come from the primitive's classes).
                transitionProperty: "translate, scale, opacity, bottom",
              }}
            />
          </MessageScroller>
        </MessageScrollerProvider>

        {/* The composer is a bottom OVERLAY over the scroller (BRO-1626): an OPAQUE
            bar (bg-background) so messages never bleed through the input (BRO-1628);
            the scroller reserves matching bottom clearance so no message hides behind
            it. On mobile it slides toward older messages (freeing reading space) and
            returns toward the newest — translateY past the edge (not overflow-clip)
            keeps the running halo intact. */}
        <footer
          ref={composerRef}
          data-hidden={composerHidden ? "true" : undefined}
          inert={composerHidden || undefined}
          // Capture-phase focus tracking for the WHOLE composer — textarea, the
          // model/effort selects, attach menu, and send button. A focused composer
          // never auto-hides (so we never inert + blur the control being used,
          // which on mobile would collapse the keyboard mid-typing). P20 BRO-1626.
          onFocusCapture={() => setComposerFocused(true)}
          onBlurCapture={(e) => setComposerFocused(e.currentTarget.contains(e.relatedTarget))}
          className={cn(
            "bg-background absolute inset-x-0 bottom-0 px-4 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
            // A soft top edge so messages fade INTO the bar instead of a hard cut.
            // Fade to a zero-alpha SAME-HUE background (not `transparent` = black-0)
            // so the 16px strip doesn't pick up a gray fringe (BRO-1628 P20). Kept
            // short (16px, was 20px) so it doesn't wash out the last turn's action
            // row (run-time/copy/retry) that sits just above the bar (BRO-1704).
            "before:pointer-events-none before:absolute before:inset-x-0 before:-top-4 before:h-4 before:bg-gradient-to-t before:from-background before:to-[color-mix(in_oklab,var(--background),transparent)]",
            "transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.2,0,0,1)] will-change-transform motion-reduce:transition-none",
            composerHidden
              ? "pointer-events-none translate-y-[110%] opacity-0"
              : "translate-y-0 opacity-100",
          )}
        >
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
              {/* The Undertow breathes behind the glass composer while a turn is in
                flight (BRO-1590) — the DS running signal as a composer
                microinteraction. data-streaming gates the aura; idle is silent. */}
              <div className="bv-composer-aura" data-streaming={busy ? "true" : undefined}>
                {/* PromptInputProvider lifts the textarea state so input-history
                  recall (BRO-1598) can write recalled text back through the
                  controller. Without it PromptInput stays self-managed and recall
                  can't reach the value. */}
                <PromptInputProvider>
                  {/* Staged attachments row (BRO-1706) — visible feedback that files
                      are attached, with per-file remove; renders nothing when empty. */}
                  <ComposerAttachments className="mb-2" />
                  <PromptInput
                    onSubmit={handleSubmit}
                    multiple
                    // Broad by design (BRO-1706): images/PDFs/text/code all work; the
                    // agent Reads whatever lands. Bound count + per-file size (with
                    // onError feedback) instead of narrowing the type.
                    maxFiles={10}
                    maxFileSize={15 * 1024 * 1024}
                    onError={(e) => setNotice(e.message)}
                    className="bv-composer w-full"
                  >
                    <PromptInputBody>
                      <RecallTextarea history={userHistory} />
                    </PromptInputBody>
                    <PromptInputFooter>
                      <PromptInputTools>
                        <PromptInputActionMenu>
                          <PromptInputActionMenuTrigger aria-label="Attach files">
                            <Paperclip className="size-4" />
                          </PromptInputActionMenuTrigger>
                          <PromptInputActionMenuContent>
                            <PromptInputActionAddAttachments label="Add photos & files" />
                            {/* Desktop screen-capture (BRO-1706) — no-ops where the
                                getDisplayMedia API is unavailable (e.g. mobile). */}
                            <PromptInputActionAddScreenshot label="Take screenshot" />
                          </PromptInputActionMenuContent>
                        </PromptInputActionMenu>
                        {/* Workspace picker removed from the composer (BRO-1662): the
                          launcher card owns pre-session workspace selection and the
                          header carries the bound workspace, so the toolbar no longer
                          crowds the input with a workspace chip. */}
                        {/* Provider-aware model/effort (BRO-1623). Options follow the
                          engine's provider (claude aliases vs OpenAI models); the
                          model selector locks once an interactive thread's session
                          has spawned (its model binds at spawn). Effort is hidden
                          for interactive (no clean per-launch reasoning knob). */}
                        {engineShowsModel(engine) ? (
                          <PromptInputSelect
                            value={effModel}
                            onValueChange={onModelChange}
                            disabled={modelLocked}
                          >
                            <PromptInputSelectTrigger
                              aria-label={
                                modelLocked ? "Model (locked — session running)" : "Model"
                              }
                            >
                              <PromptInputSelectValue />
                            </PromptInputSelectTrigger>
                            <PromptInputSelectContent>
                              {modelOptionsFor(engine).map((o) => (
                                <PromptInputSelectItem key={o.value} value={o.value}>
                                  {o.label}
                                </PromptInputSelectItem>
                              ))}
                            </PromptInputSelectContent>
                          </PromptInputSelect>
                        ) : null}
                        {engineShowsEffort(engine) ? (
                          <PromptInputSelect value={effEffort} onValueChange={onEffortChange}>
                            <PromptInputSelectTrigger aria-label="Effort">
                              <PromptInputSelectValue />
                            </PromptInputSelectTrigger>
                            <PromptInputSelectContent>
                              {effortOptionsFor(engine).map((o) => (
                                <PromptInputSelectItem key={o.value} value={o.value}>
                                  {o.label}
                                </PromptInputSelectItem>
                              ))}
                            </PromptInputSelectContent>
                          </PromptInputSelect>
                        ) : null}
                      </PromptInputTools>
                      {/* Right group: the context meter (BRO-1604) sits next to the
                        send button — a compact usage trigger that opens the breakdown
                        popover, off the top of the composer where it crowded spacing. */}
                      <div className="flex items-center gap-1.5">
                        <ContextMeter data={meterData} />
                        {/* DS send — a circular primary-fill button with the DS up-arrow
                  at rest. The component swaps in its own spinner/stop/error glyphs
                  for the in-flight states, so only the idle icon is overridden.
                  onStop → during a stream the button becomes type=button and aborts
                  directly (no form submit/reset), so text typed mid-stream isn't
                  wiped (P20 BRO-1573). handleSubmit's busy-guard is the Enter-key
                  fallback. */}
                        <PromptInputSubmit
                          status={status}
                          onStop={stop}
                          className="size-9 rounded-full"
                        >
                          {status === "ready" ? <ArrowUp className="size-4" /> : undefined}
                        </PromptInputSubmit>
                      </div>
                    </PromptInputFooter>
                  </PromptInput>
                </PromptInputProvider>
              </div>
            </TooltipProvider>
          </div>
        </footer>
      </div>
    </div>
  );
}
