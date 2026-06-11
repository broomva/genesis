// TranscriptTailer — incremental reader of a session transcript JSONL file.
//
// Invariants (stability ladder):
// - The path comes from hook input (`transcript_path`) — NEVER reconstructed
//   from cwd (the lossy dash-encoding of ~/.claude/projects broke happy-cli,
//   opcode, and claude-powerline).
// - Snapshot + live tail: on start it replays the existing file from offset 0
//   (late-joiner / daemon-restart recovery), then streams appended bytes.
// - Partial-line safe: bytes after the last newline are buffered until the
//   next read (the CLI writes whole lines, but reads can race a write).
// - Watcher strategy: fs.watch on the file when it exists; polling fallback
//   (250ms) covers editors/filesystems where watch events are unreliable.

import { type FSWatcher, watch } from "node:fs";
import { open, stat } from "node:fs/promises";

export interface TailerOptions {
  path: string;
  /** Called once per complete line (without the trailing newline). */
  onLine: (line: string) => void;
  /** Called when the snapshot replay (existing content) has been delivered. */
  onCaughtUp?: () => void;
  /** Poll interval fallback in ms (default 250). */
  pollMs?: number;
}

export class TranscriptTailer {
  private readonly path: string;
  private readonly onLine: (line: string) => void;
  private readonly onCaughtUp?: () => void;
  private readonly pollMs: number;
  private offset = 0;
  private partial = "";
  private watcher: FSWatcher | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private reading = false;
  private pending = false;
  private stopped = false;

  constructor(opts: TailerOptions) {
    this.path = opts.path;
    this.onLine = opts.onLine;
    this.onCaughtUp = opts.onCaughtUp;
    this.pollMs = opts.pollMs ?? 250;
  }

  async start(): Promise<void> {
    await this.drain();
    this.onCaughtUp?.();
    try {
      this.watcher = watch(this.path, () => void this.drain());
    } catch {
      // File may not exist yet or watch unsupported — polling covers it.
    }
    this.pollTimer = setInterval(() => void this.drain(), this.pollMs);
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
  }

  /** Read any new bytes past the current offset and emit complete lines. */
  private async drain(): Promise<void> {
    if (this.stopped) return;
    if (this.reading) {
      this.pending = true;
      return;
    }
    this.reading = true;
    try {
      const size = await fileSize(this.path);
      if (size === undefined) return; // not created yet
      if (size < this.offset) {
        // Truncated/rotated — restart from the top (transcript rewrites can
        // happen on resume; replaying is safe because consumers dedupe).
        this.offset = 0;
        this.partial = "";
      }
      if (size === this.offset) return;
      const handle = await open(this.path, "r");
      try {
        const length = size - this.offset;
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
        this.offset += bytesRead;
        const chunk = this.partial + buffer.subarray(0, bytesRead).toString("utf8");
        const lines = chunk.split("\n");
        this.partial = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length > 0) this.onLine(line);
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Transient read errors are retried on the next poll tick.
    } finally {
      this.reading = false;
      if (this.pending) {
        this.pending = false;
        void this.drain();
      }
    }
  }
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}
