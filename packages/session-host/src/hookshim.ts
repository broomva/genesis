// hookshim — builds the per-session `--settings` JSON that wires Claude Code's
// documented hook + statusline contracts to the daemon's unix socket.
//
// The shim is plain `curl --unix-socket` (no custom script on disk): hook
// stdin JSON is POSTed with `--data-binary @-`, and whatever the daemon
// returns on the response body is printed to stdout — which is exactly where
// Claude Code reads hook decisions. Failure posture: `--max-time` + curl
// exiting non-zero degrades to Claude Code's native behavior (hooks are
// advisory when their command fails), so a dead daemon never wedges a session.

export interface ShimOptions {
  socketPath: string;
  /** PreToolUse hold-open ceiling in seconds (default 600). */
  permissionTimeoutSecs?: number;
  /** Fast-hook timeout in seconds for non-blocking events (default 10). */
  eventTimeoutSecs?: number;
}

function curlCmd(socketPath: string, route: string, maxTimeSecs: number): string {
  // -s silent, -f fail-on-http-error (degrade cleanly), --max-time bounds the
  // hold-open. Response body → stdout → Claude Code.
  return `curl -sf --unix-socket ${shellQuote(socketPath)} --max-time ${maxTimeSecs} -X POST -H 'Content-Type: application/json' --data-binary @- http://genesis${route}`;
}

/** Settings object for `claude --settings '<json>'` (documented flag). */
export function buildSessionSettings(opts: ShimOptions): Record<string, unknown> {
  const sock = opts.socketPath;
  const fast = opts.eventTimeoutSecs ?? 10;
  const slow = opts.permissionTimeoutSecs ?? 600;
  const fastHook = (route = "/hook") => ({
    hooks: [{ type: "command", command: curlCmd(sock, route, fast), timeout: fast + 5 }],
  });
  return {
    hooks: {
      SessionStart: [fastHook()],
      SessionEnd: [fastHook()],
      UserPromptSubmit: [fastHook()],
      PreToolUse: [
        {
          hooks: [{ type: "command", command: curlCmd(sock, "/hook", slow), timeout: slow + 10 }],
        },
      ],
      PostToolUse: [fastHook()],
      // The live content plane: streaming assistant deltas (v2.1.152+).
      MessageDisplay: [fastHook()],
      Notification: [fastHook()],
      Stop: [fastHook()],
    },
    statusLine: {
      type: "command",
      command: curlCmd(sock, "/statusline", fast),
    },
  };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
