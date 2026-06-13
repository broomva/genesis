// InputActuator — the ONLY module that touches the fragile actuation surface
// (rung 8 of the stability ladder). Everything else observes via contracts.
//
// TmuxActuator: battle-tested PTY layer with zero native deps under Bun
// (node-pty's native module is the riskier path in this runtime — tmux has
// run claude-remote-sessions for months). Keystroke use is limited to:
// text + Enter (send a turn), Escape (interrupt). The screen is NEVER parsed;
// `pipe-pane` streams raw bytes for the render-only fallback view.

import { shellQuote } from "./hookshim";

export interface SpawnSpec {
  /** tmux session name (unique per Claude session). */
  name: string;
  /** Absolute path to the (pinned) claude binary. */
  bin: string;
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Raw PTY byte sink file for the fallback terminal view (optional). */
  rawSinkPath?: string;
  cols?: number;
  rows?: number;
}

export interface SendOptions {
  /** Clear the composer (Escape + Ctrl-U) BEFORE typing. Used on retries: a
   *  wedged composer (text present but un-submittable) doesn't recover from a
   *  bare Enter, but DOES from clear-then-retype-then-submit (diagnosed live,
   *  2026-06-13). NOT used on the trust-dialog nudge — Escape would cancel it. */
  clearFirst?: boolean;
}

export interface InputActuator {
  spawn(spec: SpawnSpec): Promise<void>;
  /** Type a user turn (literal text, then submit). */
  send(name: string, text: string, opts?: SendOptions): Promise<void>;
  /** Send a single Escape (interrupt the current turn). */
  interrupt(name: string): Promise<void>;
  alive(name: string): Promise<boolean>;
  kill(name: string): Promise<void>;
}

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export class TmuxActuator implements InputActuator {
  async spawn(spec: SpawnSpec): Promise<void> {
    const args = [
      "tmux",
      "new-session",
      "-d",
      "-s",
      spec.name,
      "-c",
      spec.cwd,
      "-x",
      String(spec.cols ?? 220),
      "-y",
      String(spec.rows ?? 50),
    ];
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      args.push("-e", `${key}=${value}`);
    }
    args.push("--", spec.bin, ...spec.argv);
    const result = await run(args);
    if (result.code !== 0) {
      throw new Error(`tmux new-session failed (${result.code}): ${result.stderr.trim()}`);
    }
    if (spec.rawSinkPath !== undefined) {
      // Render-only fallback stream — never parsed by the host. The path is
      // shell-quoted: tmux hands the pipe-pane command to `sh -c` (P20 B1).
      const piped = await run([
        "tmux",
        "pipe-pane",
        "-t",
        spec.name,
        "-o",
        `cat >> ${shellQuote(spec.rawSinkPath)}`,
      ]);
      if (piped.code !== 0) {
        throw new Error(`tmux pipe-pane failed (${piped.code}): ${piped.stderr.trim()}`);
      }
    }
  }

  async send(name: string, text: string, opts?: SendOptions): Promise<void> {
    // Recovery for a wedged composer (retries): Escape dismisses any open
    // overlay/autocomplete, Ctrl-U clears the line, so the retype lands in a
    // clean composer. A bare Enter alone does NOT recover a wedge.
    if (opts?.clearFirst) {
      await run(["tmux", "send-keys", "-t", name, "Escape"]);
      await run(["tmux", "send-keys", "-t", name, "C-u"]);
    }
    if (text.length > 0) {
      // -l = literal (no key-name interpretation); submit sent separately.
      const typed = await run(["tmux", "send-keys", "-t", name, "-l", "--", text]);
      if (typed.code !== 0) {
        throw new Error(`tmux send-keys failed (${typed.code}): ${typed.stderr.trim()}`);
      }
    }
    // C-m (carriage return) submits — the form that reliably submitted in the
    // live wedge diagnostic.
    const entered = await run(["tmux", "send-keys", "-t", name, "C-m"]);
    if (entered.code !== 0) {
      throw new Error(`tmux send-keys submit failed (${entered.code}): ${entered.stderr.trim()}`);
    }
  }

  async interrupt(name: string): Promise<void> {
    await run(["tmux", "send-keys", "-t", name, "Escape"]);
  }

  async alive(name: string): Promise<boolean> {
    return (await run(["tmux", "has-session", "-t", name])).code === 0;
  }

  async kill(name: string): Promise<void> {
    await run(["tmux", "kill-session", "-t", name]);
  }
}
