// Genesis domain model (Phase 1 subset). Mirrors the Hawthorne
// Workspace/Session object-model *learning*, trimmed to the walking skeleton.
// Phase 2 (Soul Substrate) promotes these from in-memory to Postgres+Drizzle.

import type { RunPhase, TokenUsage, TurnPart } from "@genesis/projection";

export type { RunPhase, TokenUsage, TurnPart };

export interface Workspace {
  id: string;
  name: string;
  /** A git repository root the agent operates in. */
  rootPath: string;
}

export interface Session {
  id: string;
  workspaceId: string;
  /** The channel thread this session is bound to (chat-id → session). */
  threadId: string;
  /** The coding-agent session id, for `--resume` continuity. */
  agentSessionId?: string;
  phase: RunPhase;
  createdAt: string;
  /** Soft-archived → hidden from the default drawer list, reversible (BRO-1592).
   *  Optional for back-compat; treat absent as false. */
  archived?: boolean;
  /** Human-readable thread title — auto-derived from the first user turn, or
   *  renamed (BRO-1592). Absent → the drawer falls back to a last-text preview. */
  title?: string;
  /** Resolved agent engine for this thread (BRO-1620) — bound STICKY on the first
   *  turn and reused for every later turn + control op, so flipping the global
   *  default never reroutes a thread that already has a live (e.g. tmux) session.
   *  Absent → bound on the next turn: a NEVER-RUN thread takes the client's
   *  requested engine; an existing thread that already ran (pre-BRO-1620 row) is
   *  bound to the supervisor's defaultEngine to preserve its actual engine. */
  engine?: string;
}

export interface Turn {
  id: string;
  sessionId: string;
  role: "user" | "agent";
  text: string;
  createdAt: string;
  /** Token usage for this turn (BRO-1597) — set on the agent turn from the CLI's
   *  terminal result. Absent on user turns and on pre-usage historical turns. */
  usage?: TokenUsage;
  /** claude's exact cost for the turn (USD). Absent → unknown (e.g. user turn). */
  costUsd?: number;
  /** Ordered text+tool timeline (BRO-1607) — set on the agent turn so a reloaded
   *  thread rebuilds tool blocks + interleaving, not just the final text. Absent
   *  on user turns and pre-1607 historical rows (reload falls back to `text`). */
  parts?: TurnPart[];
  /** Extended-thinking token estimate (BRO-1607 reload of BRO-1574) — the `~N
   *  tokens` budget on the reloaded reasoning indicator. Absent / 0 at effort high
   *  (the CLI reports no estimate) — does NOT mean "no thinking"; see `reasoned`. */
  thinkingTokens?: number;
  /** The model used extended thinking this turn (BRO-1608) — drives WHETHER the
   *  reasoning indicator shows on a reloaded turn, independent of the token count
   *  (which is 0 at effort high). Absent on user turns / pre-1608 rows. */
  reasoned?: boolean;
  /** Verbatim reasoning prose (BRO-1608) — persisted so a reload shows the REAL
   *  reasoning, identical to the live turn, whenever a deployment provides it
   *  (e.g. ANTHROPIC_API_KEY auth). Absent under subscription auth (redacted to "")
   *  and on user / pre-1608 rows → reload falls back to the indicator note. */
  reasoning?: string;
  /** Server-measured agent run time in ms (BRO-1610) — set on the agent turn, so a
   *  reloaded thread shows each turn's total run time ("5m 24s"). Absent on user /
   *  pre-1610 rows. */
  durationMs?: number;
}
