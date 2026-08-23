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
  /** rootPath is itself a git repo (informational / display). Optional. */
  isGitRepo?: boolean;
  /** Run the agent DIRECTLY in rootPath instead of a per-session worktree
   *  (BRO-1512) — true for nested-monorepo workspaces. Absent → the supervisor
   *  global (noWorktree). Lives in the boot registry only; NOT persisted to the
   *  DB (recomputed every boot, so it can never go stale). */
  noWorktree?: boolean;
  /** This workspace serves an UNTRUSTED principal (BRO-2224) — a public channel
   *  tenant rather than the operator. The agent spawn is hardened for it.
   *
   *  Today that means `--strict-mcp-config`, which drops every inherited MCP
   *  server. Measured on the VPS: without it a tenant session carries
   *  mcp__railway__set_variables / update_service / whoami plus the account's
   *  Gmail, Drive and Calendar connectors; with it the session reports NONE.
   *  MCP servers run OUTSIDE the filesystem sandbox by documented design, so no
   *  amount of path confinement reaches them — this flag is the only thing that
   *  does.
   *
   *  A PROPERTY OF THE WORKSPACE, not of the request: the client picks a
   *  workspaceId, so a request-level flag would let the caller choose to be
   *  unconfined. Set from the manifest, server-side, at provisioning time. */
  confined?: boolean;
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
  /** Sticky per-session worktree posture (BRO-1656) — bound on the first turn from
   *  the client's root/worktree choice: `true` = run at the workspace root, `false`
   *  = cut a per-session worktree. Reused after, and PERSISTED so a resumed thread
   *  keeps its cwd instead of re-deriving from the (mutable) workspace registry.
   *  Absent → inherit the workspace's `noWorktree` default (BRO-1512), else global. */
  noWorktree?: boolean;
  /** The git branch the session's cwd is on (BRO-1664) — captured from the run each
   *  turn: `genesis/<key>` for a worktree session, the repo's current branch for a
   *  root session. Refreshes if the branch changes. Absent on a never-run thread or a
   *  non-git cwd (the header then falls back to the root/worktree posture). */
  branch?: string;
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
