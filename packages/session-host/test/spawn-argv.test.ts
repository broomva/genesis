import { describe, expect, test } from "bun:test";
import type { InputActuator, SendOptions, SpawnSpec } from "../src/actuator";
import { SessionHost, type SessionHub } from "../src/session";

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
});
