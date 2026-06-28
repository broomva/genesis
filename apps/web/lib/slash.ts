// Slash-command parsing for the PWA composer (BRO-1576). A `/`-prefixed message
// is a local command, not an agent turn — the composer intercepts it before
// sendMessage. Pure + tested so the command surface is unambiguous.

export type SlashCommand = "new" | "reset" | "help";

export interface SlashSpec {
  command: SlashCommand;
  aliases: readonly string[];
  summary: string;
}

/** The registered commands (single source of truth for parsing + /help). */
export const SLASH_COMMANDS: readonly SlashSpec[] = [
  { command: "new", aliases: ["/new"], summary: "Start a new conversation" },
  {
    command: "reset",
    aliases: ["/reset", "/clear"],
    summary: "Reset the agent's memory for this thread",
  },
  { command: "help", aliases: ["/help", "/?"], summary: "Show available commands" },
];

/** Parse a composer input into a slash command, or null if it's a normal message.
 *  Matches the first whitespace-delimited token case-insensitively, so trailing
 *  args (ignored for now) don't break the match. Only a leading `/` triggers it. */
export function parseSlash(input: string): SlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const token = trimmed.split(/\s+/, 1)[0].toLowerCase();
  for (const spec of SLASH_COMMANDS) {
    if (spec.aliases.includes(token)) return spec.command;
  }
  return null;
}

/** The /help body — one line per command. */
export function slashHelpText(): string {
  return SLASH_COMMANDS.map((s) => `${s.aliases.join(", ")} — ${s.summary}`).join("\n");
}
