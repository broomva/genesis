// Slash-command framework (BRO-1493).
//
// Two classes of command over Telegram:
//   1. CONTROL commands (/new, /stop, /status, /help, /commands) — handled at
//      the bot layer, mapped to Genesis /control actions or local replies.
//      These populate the native Telegram `/` menu via setMyCommands.
//   2. SESSION commands — every Claude Code skill (/<skill>) + built-ins. These
//      are NOT registered in the native menu (96+ skills exceed Telegram's
//      100-command cap and most are dev-workflow). Instead `/commands` lists the
//      full palette dynamically, and typing any /<skill> forwards to the session
//      as a normal turn (the agent runs the skill) — so all are "inherited".

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A control command shown in the native Telegram `/` menu. */
export interface ControlCommand {
  /** Command name without the leading slash (Telegram setMyCommands form). */
  command: string;
  description: string;
}

/** The curated control set — small, useful, always in the `/` menu. */
export const CONTROL_COMMANDS: readonly ControlCommand[] = [
  { command: "new", description: "Start a fresh conversation (clears the agent's context)" },
  { command: "stop", description: "Interrupt the current turn" },
  { command: "status", description: "Show this conversation's session state" },
  { command: "commands", description: "List every command the agent session supports" },
  { command: "help", description: "What this bot can do" },
];

/** Aliases that route to the same control action. */
export const CONTROL_ALIASES: Record<string, string> = {
  new: "new",
  reset: "new",
  clear: "new",
  stop: "stop",
  cancel: "stop",
  interrupt: "stop",
  status: "status",
  commands: "commands",
  skills: "commands",
  help: "help",
  start: "help",
};

/** Map a raw command token (no slash, lowercased) to a control action, or
 *  undefined when it's a session/skill command to forward to the agent. */
export function controlAction(command: string): string | undefined {
  return CONTROL_ALIASES[command.toLowerCase()];
}

/** A discovered session command (built-in or skill). */
export interface SessionCommand {
  name: string;
  description: string;
  kind: "builtin" | "skill";
}

/** Claude Code built-in commands worth surfacing in `/commands` (curated;
 *  the overlay ones are handled, the rest are informational). */
const BUILTIN_COMMANDS: readonly SessionCommand[] = [
  { name: "model", description: "Switch the model (use /new then ask, for now)", kind: "builtin" },
  { name: "clear", description: "Clear context — use /new", kind: "builtin" },
  { name: "compact", description: "Summarize and compact the conversation", kind: "builtin" },
  { name: "help", description: "Claude Code help", kind: "builtin" },
];

/** First line of a skill's `description:` frontmatter, trimmed for a menu. */
function skillDescription(skillMd: string): string {
  const match = skillMd.match(/^description:\s*["']?(.+?)["']?\s*$/im);
  const raw = match?.[1] ?? "";
  // Frontmatter descriptions can be paragraph-length; take the first sentence.
  const firstSentence = raw.split(/(?<=\.)\s/)[0] ?? raw;
  return firstSentence.length > 120 ? `${firstSentence.slice(0, 117)}…` : firstSentence;
}

/** Enumerate installed skills from a skills directory (each = a /command). */
function readSkills(dir: string): SessionCommand[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SessionCommand[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    let md = "";
    try {
      md = readFileSync(join(dir, name, "SKILL.md"), "utf8");
    } catch {
      continue; // not a skill dir
    }
    out.push({
      name: name.toLowerCase(),
      description: skillDescription(md),
      kind: "skill",
    });
  }
  return out;
}

export interface EnumerateOptions {
  /** Skills directories to scan. Default: the user skills dir. */
  skillsDirs?: string[];
}

/**
 * Enumerate the session's full command palette: built-ins + installed skills,
 * de-duplicated by name, sorted. This is the source for `/commands` — the
 * literal "show all commands active on the session".
 */
export function enumerateSessionCommands(opts: EnumerateOptions = {}): SessionCommand[] {
  const dirs = opts.skillsDirs ?? [join(homedir(), ".claude", "skills")];
  const seen = new Map<string, SessionCommand>();
  for (const b of BUILTIN_COMMANDS) seen.set(b.name, b);
  for (const dir of dirs) {
    for (const skill of readSkills(dir)) {
      if (!seen.has(skill.name)) seen.set(skill.name, skill);
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Render the `/commands` reply (grouped, Telegram-markdown-safe). */
export function renderCommandList(commands: SessionCommand[]): string {
  const builtins = commands.filter((c) => c.kind === "builtin");
  const skills = commands.filter((c) => c.kind === "skill");
  const lines: string[] = ["*Agent commands*", ""];
  if (builtins.length > 0) {
    lines.push("Built-in:");
    for (const c of builtins) lines.push(`• /${c.name} — ${c.description}`);
    lines.push("");
  }
  lines.push(`Skills (${skills.length}) — type /<name> to run any of them:`);
  // Keep the message under Telegram's 4096-char cap: names only, comma-joined.
  lines.push(skills.map((c) => `/${c.name}`).join("  "));
  return lines.join("\n");
}

/** The static `/help` reply. */
export function renderHelp(): string {
  return [
    "*Genesis agent bot* — I run an interactive Claude Code session for this chat.",
    "",
    "Just talk to me normally. Controls:",
    ...CONTROL_COMMANDS.map((c) => `• /${c.command} — ${c.description}`),
    "",
    "Any /<skill> runs that Claude Code skill. /commands lists them all.",
  ].join("\n");
}
