// Genesis domain model (Phase 1 subset). Mirrors the Hawthorne
// Workspace/Session object-model *learning*, trimmed to the walking skeleton.
// Phase 2 (Soul Substrate) promotes these from in-memory to Postgres+Drizzle.

import type { RunPhase } from "@genesis/projection";

export type { RunPhase };

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
}

export interface Turn {
  id: string;
  sessionId: string;
  role: "user" | "agent";
  text: string;
  createdAt: string;
}
