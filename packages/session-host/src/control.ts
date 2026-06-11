// ControlServer — the hook control plane. One unix-domain socket per daemon;
// Claude Code hooks (documented contract) POST their stdin JSON here via the
// curl shim (`hookshim.ts`). Hook payloads carry `session_id`, so a single
// socket multiplexes N sessions.
//
// PreToolUse is the hold-open permission flow: the HTTP response is delayed
// until policy or a client resolves the request, then the documented
// `hookSpecificOutput.permissionDecision` JSON is returned and Claude Code
// proceeds — no TUI dialog, no screen-scraping (probed 2026-06-11, v2.1.173).

import type { IREvent, PermissionDecision, PermissionRequestEvent } from "./ir";

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  toolUseId?: string;
  resolve: (
    decision: PermissionDecision,
    reason: string,
    source: "policy" | "client" | "timeout",
  ) => void;
}

/**
 * Synchronous-or-async policy check. Return a decision to auto-resolve, or
 * `undefined` to hold the request open for a client (UI card).
 */
export type PermissionPolicy = (request: {
  sessionId: string;
  toolName: string;
  toolInput: unknown;
}) =>
  | { decision: PermissionDecision; reason?: string }
  | undefined
  | Promise<{ decision: PermissionDecision; reason?: string } | undefined>;

export type { PermissionDecision } from "./ir";

export interface ControlServerOptions {
  socketPath: string;
  onEvent: (event: IREvent) => void;
  /** Auto-resolution policy; undefined → all requests hold for a client. */
  policy?: PermissionPolicy;
  /** Hold-open ceiling before the timeout fallback fires (default 590s —
   *  just under the 600s hook timeout configured by hookshim). */
  holdOpenMs?: number;
  /** Decision returned when the hold-open ceiling is hit (default "ask":
   *  defer to Claude Code's own permission flow rather than failing closed). */
  timeoutDecision?: PermissionDecision;
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `perm-${process.pid.toString(36)}-${requestCounter}`;
}

export class ControlServer {
  private server: ReturnType<typeof Bun.serve> | undefined;
  private readonly opts: ControlServerOptions;
  private readonly pending = new Map<string, PendingPermission>();

  constructor(opts: ControlServerOptions) {
    this.opts = opts;
  }

  get socketPath(): string {
    return this.opts.socketPath;
  }

  start(): void {
    this.server = Bun.serve({
      unix: this.opts.socketPath,
      fetch: (req) => this.route(req),
    });
  }

  stop(): void {
    for (const p of this.pending.values()) {
      p.resolve("ask", "control server shutting down", "timeout");
    }
    this.pending.clear();
    this.server?.stop(true);
  }

  /** Resolve a held permission request (the UI card path). */
  respond(requestId: string, decision: PermissionDecision, reason?: string): boolean {
    const held = this.pending.get(requestId);
    if (held === undefined) return false;
    held.resolve(decision, reason ?? "resolved by client", "client");
    return true;
  }

  /** Requests currently held open (for late-joining clients). */
  pendingRequests(): PendingPermission[] {
    return [...this.pending.values()];
  }

  // --- routing -----------------------------------------------------------

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname === "/hook") {
        return await this.handleHook(await req.json());
      }
      if (req.method === "POST" && url.pathname === "/statusline") {
        return this.handleStatusline(await req.json());
      }
    } catch (error) {
      this.emitUnknown("hook", { routeError: String(error) });
      return Response.json({});
    }
    return new Response("not found", { status: 404 });
  }

  private async handleHook(payload: unknown): Promise<Response> {
    const body = asRecord(payload);
    if (body === undefined) {
      this.emitUnknown("hook", payload);
      return Response.json({});
    }
    const sessionId = asString(body.session_id) ?? "<unknown-session>";
    const eventName = asString(body.hook_event_name) ?? "<unknown-hook>";
    const observedAt = Date.now();
    const base = { sessionId, observedAt, surface: "hook" as const };

    switch (eventName) {
      case "SessionStart": {
        this.opts.onEvent({
          ...base,
          kind: "session.lifecycle",
          phase: "ready",
          transcriptPath: asString(body.transcript_path),
          detail: { source: asString(body.source) },
        });
        return Response.json({});
      }
      case "SessionEnd": {
        this.opts.onEvent({ ...base, kind: "session.lifecycle", phase: "ended" });
        return Response.json({});
      }
      case "UserPromptSubmit": {
        // Hooks ARE the live content plane: plain TTY-interactive sessions on
        // 2.1.173 do NOT persist transcript content (probed 2026-06-11 — only
        // sdk-driven sessions write live; cli no-TTY flushes at exit). The
        // transcript surface is history/recovery, not streaming.
        this.opts.onEvent({ ...base, kind: "message.user", text: asString(body.prompt) ?? "" });
        return Response.json({});
      }
      case "PreToolUse": {
        this.opts.onEvent({
          ...base,
          kind: "tool.use",
          toolUseId: asString(body.tool_use_id),
          name: asString(body.tool_name) ?? "<unknown-tool>",
          input: body.tool_input,
        });
        return await this.holdPermission(sessionId, body);
      }
      case "PostToolUse": {
        this.opts.onEvent({
          ...base,
          kind: "tool.result",
          toolUseId: asString(body.tool_use_id),
          content: body.tool_response,
          isError: isErrorResponse(body.tool_response),
          durationMs: asNumber(body.duration_ms),
        });
        return Response.json({});
      }
      case "MessageDisplay": {
        // Streaming assistant text deltas — the documented streaming surface:
        // {turn_id, message_id, index, final, delta} (observed v2.1.173).
        this.opts.onEvent({
          ...base,
          kind: "message.assistant",
          text: asString(body.delta) ?? "",
          messageId: asString(body.message_id),
          streaming: {
            turnId: asString(body.turn_id),
            index: asNumber(body.index),
            final: body.final === true,
          },
        });
        return Response.json({});
      }
      case "Stop": {
        this.opts.onEvent({
          ...base,
          kind: "turn.complete",
          lastAssistantMessage: asString(body.last_assistant_message),
        });
        return Response.json({});
      }
      case "Notification": {
        const message = asString(body.message);
        const type = asString(body.notification_type) ?? asString(body.matcher);
        this.opts.onEvent({
          ...base,
          kind: "awaiting",
          what:
            type === "permission_prompt" ? "permission" : type === "idle_prompt" ? "idle" : "other",
          message,
        });
        return Response.json({});
      }
      default: {
        this.emitUnknown(eventName, body, sessionId);
        return Response.json({});
      }
    }
  }

  private async holdPermission(
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const toolName = asString(body.tool_name) ?? "<unknown-tool>";
    const toolInput = body.tool_input;
    const toolUseId = asString(body.tool_use_id);
    const requestId = nextRequestId();

    // 1. Policy first — synchronous auto-allow/deny without surfacing a card.
    const policyVerdict = await this.opts.policy?.({ sessionId, toolName, toolInput });
    if (policyVerdict !== undefined) {
      this.emitResolved(
        sessionId,
        requestId,
        policyVerdict.decision,
        policyVerdict.reason,
        "policy",
      );
      return permissionResponse(policyVerdict.decision, policyVerdict.reason ?? "genesis policy");
    }

    // 2. Hold open for a client.
    const requestEvent: PermissionRequestEvent = {
      kind: "permission.request",
      sessionId,
      observedAt: Date.now(),
      surface: "hook",
      requestId,
      toolName,
      toolInput,
      toolUseId,
    };

    const decision = await new Promise<{
      d: PermissionDecision;
      reason: string;
      source: "policy" | "client" | "timeout";
    }>((resolvePromise) => {
      const timeout = setTimeout(() => {
        finish(this.opts.timeoutDecision ?? "ask", "hold-open ceiling reached", "timeout");
      }, this.opts.holdOpenMs ?? 590_000);
      const finish = (
        d: PermissionDecision,
        reason: string,
        source: "policy" | "client" | "timeout",
      ) => {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        resolvePromise({ d, reason, source });
      };
      this.pending.set(requestId, {
        requestId,
        sessionId,
        toolName,
        toolInput,
        toolUseId,
        resolve: finish,
      });
      this.opts.onEvent(requestEvent);
    });

    this.emitResolved(sessionId, requestId, decision.d, decision.reason, decision.source);
    return permissionResponse(decision.d, decision.reason);
  }

  private handleStatusline(payload: unknown): Response {
    const body = asRecord(payload) ?? {};
    const model = asRecord(body.model);
    const cost = asRecord(body.cost);
    const context = asRecord(body.context_window);
    this.opts.onEvent({
      kind: "status",
      sessionId: asString(body.session_id) ?? "<unknown-session>",
      observedAt: Date.now(),
      surface: "statusline",
      model: asString(model?.display_name) ?? asString(model?.id),
      costUsd: asNumber(cost?.total_cost_usd),
      contextUsedPct: asNumber(context?.used_percentage),
      cliVersion: asString(body.version),
      raw: payload,
    });
    // The statusline command must print a line; keep it minimal and stable.
    return new Response("genesis", { status: 200 });
  }

  private emitResolved(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
    reason: string | undefined,
    source: "policy" | "client" | "timeout",
  ): void {
    this.opts.onEvent({
      kind: "permission.resolved",
      sessionId,
      observedAt: Date.now(),
      surface: "hook",
      requestId,
      decision,
      reason,
      source,
    });
  }

  private emitUnknown(tag: string, raw: unknown, sessionId = "<unknown-session>"): void {
    this.opts.onEvent({
      kind: "unknown",
      sessionId,
      observedAt: Date.now(),
      surface: "hook",
      tag,
      raw,
    });
  }
}

/** Documented PreToolUse decision payload (code.claude.com/docs/en/hooks). */
function permissionResponse(decision: PermissionDecision, reason?: string): Response {
  return Response.json({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason ?? "genesis",
    },
  });
}

/** Best-effort error detection on the (unspecified) tool_response shape. */
function isErrorResponse(response: unknown): boolean {
  if (typeof response !== "object" || response === null) return false;
  const r = response as Record<string, unknown>;
  return r.is_error === true || r.isError === true || r.interrupted === true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
