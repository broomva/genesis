// Slash-command interception (BRO-1485 #10).
//
// Claude Code's INTERACTIVE TUI treats a leading-slash message as a built-in
// command: many open an overlay/menu (model picker, resume list, permission
// editor) or print synchronously — NONE produce an agent turn, so no Stop hook
// fires and the interactive engine would wait forever (pre-#9) or kill the
// session on a no-ack timeout (post-#9, after typing stray keystrokes into the
// menu — e.g. a bare-Enter retry selecting whatever the picker had highlighted).
//
// Either way, these must NEVER be injected as keystrokes. The engine intercepts
// them and replies directly. This is interactive-only: `claude -p "/model"` is a
// one-shot and not affected, so this lives in the interactive engine, not the
// shared runner path.
//
// Scope (v1): refuse with a helpful message. Translating the useful ones
// (`/model X` → relaunch with --model, `/clear` → fresh session) is a follow-up.
// Skill-style slash commands (`/autonomous`, `/checkit`, …) are NOT intercepted
// — they inject a prompt and DO produce a turn the engine observes normally.
// Caveat: matching is by NAME only, so a skill whose name equals a built-in
// here is shadowed (intercepted). The set is therefore kept to built-ins that
// open an overlay AND have no useful chat meaning; ambiguous names that double
// as skills (`init`, `review`) are deliberately excluded so the skill wins.

/** Built-in Claude Code commands that open a TUI overlay or print without a
 *  turn. Curated (the skill registry is open-ended, so an allow/deny by prefix
 *  is impossible) — extend as new built-ins appear. */
export const TUI_BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
  "model",
  "clear",
  "resume",
  "config",
  "agents",
  "mcp",
  "login",
  "logout",
  "permissions",
  "hooks",
  "vim",
  "terminal-setup",
  "doctor",
  "bug",
  "memory",
  "status",
  "cost",
  "help",
  "release-notes",
  "rename",
  "export",
  "add-dir",
  "ide",
  "pr-comments",
  "upgrade",
  "privacy-settings",
  "theme",
  "statusline",
  "exit",
  "quit",
]);

/**
 * If `text` is a built-in TUI command, return the chat reply to send INSTEAD of
 * injecting it; otherwise undefined (the message is a normal prompt or a
 * turn-producing skill command and flows to the session).
 *
 * Matches only when the command is the FIRST token, so a file path like
 * "/tmp/foo is broken" or prose containing a slash is never falsely caught.
 */
export function interceptSlashCommand(text: string): string | undefined {
  const match = text.trim().match(/^\/([a-z][a-z0-9-]*)(?:\b|$)/i);
  if (match === null) return undefined;
  const command = match[1]?.toLowerCase();
  if (command === undefined || !TUI_BUILTIN_COMMANDS.has(command)) return undefined;
  return `⚠️ \`/${command}\` is a Claude Code terminal command — it opens an interactive menu the chat can't drive, so it isn't available here yet. Send a plain-text request instead (e.g. “switch to a faster model” rather than \`/model\`).`;
}
