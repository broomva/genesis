import { describe, expect, spyOn, test } from "bun:test";
import type { InputActuator, SendOptions, SpawnSpec } from "../src/actuator";
import type { IREvent } from "../src/ir";
import { SessionHost, SessionHub } from "../src/session";

/** Captures the SpawnSpec without touching tmux/PTY (the only side effect of spawn). */
class CapturingActuator implements InputActuator {
  spec: SpawnSpec | undefined;
  async spawn(spec: SpawnSpec): Promise<void> {
    this.spec = spec;
  }
  async send(_name: string, _text: string, _opts?: SendOptions): Promise<void> {}
  async interrupt(_name: string): Promise<void> {}
  async alive(_name: string): Promise<boolean> {
    return true;
  }
  async kill(_name: string): Promise<void> {}
}

describe("SessionHost.spawn — argv", () => {
  test("requests always-on summarized extended thinking (BRO-1614)", async () => {
    const actuator = new CapturingActuator();
    // The hub is only used for a lifecycle dispatch during spawn; a no-op stub suffices.
    const hub = { dispatch() {} } as unknown as SessionHub;
    const host = new SessionHost(hub, "00000000-0000-0000-0000-000000000000", {
      cwd: "/repo",
      actuator,
    });

    await host.spawn("/tmp/genesis-spawn-argv-test.sock");
    const argv = actuator.spec?.argv ?? [];

    // Parity with the print engine: the hidden flag pair that defeats
    // `thinking.display:"omitted"` on Opus 4.8 / Fable 5, as adjacent flag/value pairs.
    expect(argv[argv.indexOf("--thinking") + 1]).toBe("adaptive");
    expect(argv[argv.indexOf("--thinking-display") + 1]).toBe("summarized");
    // Still interactive — never `-p` (the product invariant in session.ts:189).
    expect(argv).not.toContain("-p");
  });

  test("fresh spawn pins the id via --session-id, never --resume (BRO-1630)", async () => {
    const actuator = new CapturingActuator();
    const hub = { dispatch() {} } as unknown as SessionHub;
    const host = new SessionHost(hub, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", {
      cwd: "/repo",
      actuator,
    });
    await host.spawn("/tmp/genesis-spawn-fresh.sock");
    const argv = actuator.spec?.argv ?? [];
    expect(argv[argv.indexOf("--session-id") + 1]).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(argv).not.toContain("--resume");
  });

  test("resume spawn uses --resume <id> and OMITS --session-id (mutually exclusive) (BRO-1630)", async () => {
    const actuator = new CapturingActuator();
    const hub = { dispatch() {} } as unknown as SessionHub;
    const host = new SessionHost(hub, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", {
      cwd: "/repo",
      actuator,
      resume: true,
    });
    await host.spawn("/tmp/genesis-spawn-resume.sock");
    const argv = actuator.spec?.argv ?? [];
    // `--session-id` + `--resume` errors without `--fork-session`, so resume replaces it.
    expect(argv[argv.indexOf("--resume") + 1]).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(argv).not.toContain("--session-id");
    // Still interactive, still always-on thinking.
    expect(argv).not.toContain("-p");
    expect(argv[argv.indexOf("--thinking-display") + 1]).toBe("summarized");
  });

  test("enforces thinking flags AFTER extraArgs — operator cannot disable (BRO-1614)", async () => {
    const actuator = new CapturingActuator();
    const hub = { dispatch() {} } as unknown as SessionHub;
    const host = new SessionHost(hub, "00000000-0000-0000-0000-000000000000", {
      cwd: "/repo",
      actuator,
      // A disabling attempt through extraArgs must lose to the enforced pair.
      extraArgs: ["--thinking", "disabled", "--thinking-display", "omitted"],
    });

    await host.spawn("/tmp/genesis-spawn-argv-enforce.sock");
    const argv = actuator.spec?.argv ?? [];

    // claude is last-wins, so the enforced value is the final occurrence.
    expect(argv[argv.lastIndexOf("--thinking") + 1]).toBe("adaptive");
    expect(argv[argv.lastIndexOf("--thinking-display") + 1]).toBe("summarized");
    expect(argv.lastIndexOf("--thinking-display")).toBeGreaterThan(
      argv.indexOf("--thinking-display"),
    );
  });
});

describe("SessionHub.dispatch — unknown-session alarm (BRO-1630 P20 #1)", () => {
  const hookEvent = (sessionId: string): IREvent => ({
    kind: "message.user",
    sessionId,
    observedAt: 1,
    surface: "hook",
    text: "hi",
  });

  test("a hook for an UNKNOWN session warns LOUDLY (once per id), never throws", () => {
    const hub = new SessionHub({ socketPath: "/tmp/genesis-hub-unknown.sock" });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // No session registered for this id → the resume-reversion alarm fires.
      expect(() => hub.dispatch(hookEvent("ghost-session-xyz"))).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      // Deduped: a second hook for the SAME id does not re-warn (no log spam).
      hub.dispatch(hookEvent("ghost-session-xyz"));
      expect(warn).toHaveBeenCalledTimes(1);
      // A DIFFERENT unknown id warns again.
      hub.dispatch(hookEvent("ghost-session-abc"));
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]?.[0])).toContain("UNKNOWN session");
    } finally {
      warn.mockRestore();
    }
  });

  test("a NON-hook event for an unknown session is silent (only hooks alarm)", () => {
    const hub = new SessionHub({ socketPath: "/tmp/genesis-hub-nonhook.sock" });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      hub.dispatch({
        kind: "status",
        sessionId: "ghost",
        observedAt: 1,
        surface: "statusline",
        raw: {},
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
