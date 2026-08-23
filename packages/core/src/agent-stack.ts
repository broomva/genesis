// The bstack agent stack, seeded into a workspace's `.claude/agents` at
// provisioning time (BRO-2252).
//
// WHY SEED AT ALL. `.claude/agents/*.md` is discovered by `claude -p` — measured
// on 2.1.241: a file dropped in a project's `.claude/agents` shows up in the Task
// tool's `subagent_type` list for a print-mode session. So a workspace that comes
// up with these files comes up knowing how to run the stack; one that does not
// starts every session with only the default agent set and has to be told the
// discipline inline, every turn, forever.
//
// WHY FILES AND NOT `--agents` ON ARGV. Both work, and argv is the stronger
// boundary (a tenant cannot forge it). Files are chosen here because these are
// PROMPT-LEVEL content, not a permission boundary: an agent definition's `tools`
// list can only narrow within what `settings.json` already allows, and settings
// stays root-owned 0444. Nothing in this file can widen a tenant's capability.
// The two properties that DO gate capability — `defaultMode` and the sandbox —
// live in settings.json and are unreachable from here.
//
// WHAT AN AGENT `tools` LIST IS NOT. Measured: pinning an agent with
// `tools: ["Read","Grep"]` removed Bash from the session (no attempt, no
// permission denial — the tool simply is not there), but MCP tools passed
// straight through the allowlist and stayed callable. Narrowing here is a
// budget and a posture, never an MCP control. `--strict-mcp-config` (see
// `hardenedExtraArgs` in supervisor.ts) is still the only thing that reaches MCP.
//
// SEEDING IS A FLOOR, NOT A SYNC. An existing file is never overwritten. In a
// tenant workspace `.claude/agents` is deliberately group-writable (BRO-2245
// narrowed the write-deny to the two settings files precisely so a tenant can
// author its own skills and agents), so clobbering on every re-provision would
// silently delete the tenant's own work. `overwrite` exists for the operator
// who is intentionally rolling a new stack out.

import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One seeded agent. Mirrors the Claude Code agent-file frontmatter. */
export interface StackAgent {
  /** File basename and `subagent_type`. */
  readonly name: string;
  /** Frontmatter `description` — this is the ONLY thing the dispatching model
   *  sees when choosing an agent, so it carries the trigger vocabulary. */
  readonly description: string;
  /** Built-in tools this agent may use. Omitted → inherits the full set.
   *  Narrows built-ins only; see the MCP note in the file header. */
  readonly tools?: readonly string[];
  /** The agent's system prompt (markdown body). */
  readonly prompt: string;
}

/** The stack. Each body is SELF-CONTAINED and then points at its skill: the
 *  skill is canonical where it resolves, but a confined tenant may not have it
 *  installed, and an agent whose whole content is "load the X skill" is inert
 *  there. Ten lines of contract inline costs nothing and degrades gracefully. */
export const STACK_AGENTS: readonly StackAgent[] = [
  {
    name: "autonomous",
    description:
      "Execute agreed work end to end without checking back. Use on a bare directive — " +
      "'go', 'proceed', 'build X', 'fix Y', 'ship it', 'be autonomous', 'all green' — or " +
      "once a plan has been accepted. Fires the full bstack discipline: dependency-chain " +
      "reasoning, worktree isolation, validation by interaction, docs, CI to green.",
    prompt: `You run agreed work to completion without handing control back mid-arc.

If the \`autonomous\` skill is available, load it first — it is the canonical
spec and it supersedes this summary. What follows is the floor, for when it is not.

1. **Snapshot before acting.** Branch, \`git status\`, ahead/behind, open PRs, ticket
   state. Surface it as part of the plan, not after.
2. **Enumerate the dependency chain** before the first write — upstream files, types
   and contracts; downstream consumers, tests and CI gates — with concrete paths.
3. **Branch first.** After any \`git checkout main\`, creating the branch is the literal
   next action, before any read or edit.
4. **Validate by interacting**, not by reasoning. Run it, tail the log, exercise the
   surface. A green test suite is not evidence that the change works.
5. **Never sleep on CI.** Put a watcher on the wait and spend the wait on the next
   piece of work.
6. **Finish.** Do not stop at the easy part and report progress as completion. If a
   piece is genuinely blocked, complete everything else and say plainly what you left
   and why.

Report outcomes faithfully. If something failed, say so with the output.`,
  },
  {
    name: "p9",
    description:
      "Something is running and you are waiting on it — CI checks, a deploy, an image " +
      "build, a slow migration. Puts a watcher on the wait and spends the wait on the next " +
      "piece of work instead of polling or sleeping. Also for a wait already in flight: " +
      "'is the watcher running', 'did it notify', 'let me know when it finishes'.",
    tools: ["Bash", "Read", "Grep", "Glob"],
    prompt: `You turn a wait into background work. You never call \`sleep\` on a wait, and you
never ask which PR, URL, or command to watch — locating the target is your first
step, not a precondition.

If the \`p9\` skill is available, load it first — it is the canonical spec.

1. **Locate the target yourself.** Current branch → its PR → its checks. If there is
   no PR, the target is whatever process the caller just started.
2. **Start the watcher, then return.** The point is that the caller stops waiting.
   Report what you are watching and how they will hear about it.
3. **Drain the queue.** While it runs, do the next deferred piece of work.
4. **A red result is yours.** A failure your own watcher reported is still your wait —
   report it with the failing output, not as a bare status.

A job stops at its first failing step, so every gate after it is UNMEASURED, not
passing. Say which ones were never reached.`,
  },
  {
    name: "parallax",
    description:
      "Simulate a change before applying it, with results typed observed vs simulated. " +
      "Use for 'what happens if we change this policy', 'simulate this before applying', " +
      "propose/accept an ontology, roll it forward, run receipt. NOT for general " +
      "Monte-Carlo, forecasting, or load testing — Parallax is gated on human acceptance.",
    tools: ["Bash", "Read", "Grep", "Glob"],
    prompt: `You drive Parallax, a simulation runtime built so it cannot lie about being a
simulation. Every answer you relay carries whether it was observed or simulated.

If the \`parallax\` skill is available, load it first — it is the canonical spec
and carries the CLI surface. What follows is the operating contract.

1. **Read state from the tool, not from the conversation.** \`parallax status --json\`
   decides the next command. Conversation history is not state.
2. **The acceptance gate is real.** An ontology is proposed from what is actually in
   the context; a human accepts it before anything can run. Never paraphrase around a
   refusal — \`RECONCILIATION_UNACKNOWLEDGED\` and \`BLOCKING_QUESTIONS_OPEN\` name a
   remedy, and the remedy is the answer.
3. **Type every number you report.** Observed or simulated. An untyped figure relayed
   as fact is the failure this runtime exists to prevent.
4. **Do not offer a calibrated accuracy claim.** Parallax deliberately does not
   publish one; inventing one is worse than the gap.`,
  },
];

/** Render an agent to its `.claude/agents/<name>.md` form. Pure — the shape is
 *  covered by a test rather than by trusting the writer. */
export function agentMarkdown(agent: StackAgent): string {
  const lines = ["---", `name: ${agent.name}`, `description: ${JSON.stringify(agent.description)}`];
  if (agent.tools && agent.tools.length > 0) lines.push(`tools: ${agent.tools.join(", ")}`);
  // A provenance marker so a later reader (or a re-seed) can tell an
  // operator-seeded agent from one the workspace's own occupant wrote.
  lines.push("# seeded-by: genesis agent-stack (BRO-2252) — edit upstream, not here");
  lines.push("---", "", agent.prompt.trimEnd(), "");
  return lines.join("\n");
}

export interface SeedOwnership {
  /** File owner uid — 0 in a tenant workspace, so the occupant cannot rewrite
   *  the operator's stack even though the directory is group-writable. */
  readonly uid: number;
  readonly gid: number;
  /** File mode. 0o444 for a tenant; the caller decides. */
  readonly mode: number;
}

export interface SeedOptions {
  /** Which agents to write. Defaults to {@link STACK_AGENTS}. */
  readonly agents?: readonly StackAgent[];
  /** Replace a file that exists and differs. Default false — see the header:
   *  seeding is a floor, and `.claude/agents` is tenant-writable by design. */
  readonly overwrite?: boolean;
  /** Apply ownership/mode after writing. Requires the process to be root; only
   *  the tenant provisioner passes it. */
  readonly ownership?: SeedOwnership;
}

export interface SeedResult {
  readonly dir: string;
  /** Files this call created. */
  readonly written: string[];
  /** Files left alone because they already exist and match. */
  readonly unchanged: string[];
  /** Files left alone because they exist and DIFFER (overwrite was false).
   *  Reported rather than swallowed: a stale stack in a live tenant is exactly
   *  the state where "we rolled it out" and "it is running" disagree. */
  readonly skipped: string[];
}

/**
 * Ensure `<rootPath>/.claude/agents` exists and holds the stack.
 *
 * Idempotent. Safe to call on every provision and on every workspace
 * registration. Creates `.claude/agents` if absent — which is also what
 * bubblewrap needs to exist before it can bind its read-only placeholder over
 * that path, so seeding and the sandbox want the same directory.
 */
export function seedAgentStack(rootPath: string, opts: SeedOptions = {}): SeedResult {
  const agents = opts.agents ?? STACK_AGENTS;
  const dir = join(rootPath, ".claude", "agents");
  mkdirSync(dir, { recursive: true });

  const written: string[] = [];
  const unchanged: string[] = [];
  const skipped: string[] = [];

  for (const agent of agents) {
    const path = join(dir, `${agent.name}.md`);
    const body = agentMarkdown(agent);
    if (existsSync(path)) {
      // Compare before deciding. "Exists" alone cannot distinguish an already-
      // current stack from a stale one, and only the second is worth reporting.
      let current = "";
      try {
        current = readFileSync(path, "utf8");
      } catch {
        // Unreadable (root-owned 0444 read as a non-owner is still readable, so
        // this is the genuinely broken case) — treat as differing.
      }
      if (current === body) {
        unchanged.push(path);
        continue;
      }
      if (!opts.overwrite) {
        skipped.push(path);
        continue;
      }
      // A previous seed wrote this 0444; make it writable again before replacing.
      if (opts.ownership) {
        try {
          chmodSync(path, 0o644);
        } catch {
          // Not ours to chmod — the write below will throw and the caller sees it.
        }
      }
    }
    writeFileSync(path, body);
    if (opts.ownership) {
      chownSync(path, opts.ownership.uid, opts.ownership.gid);
      // chmodSync is safe for these modes: bun's masking bug drops bits ABOVE
      // 0o777 (the sticky bit), and nothing here sets one. Directories with a
      // sticky bit must still go through /bin/chmod — see the provisioner.
      chmodSync(path, opts.ownership.mode);
    }
    written.push(path);
  }

  return { dir, written, unchanged, skipped };
}
