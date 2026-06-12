// Closed-loop send tests (BRO-1485 #9) — the UserPromptSubmit hook as the
// actuator's submit-ack. Reproduces the live Telegram failure (Enter eaten →
// prompt stranded in the composer) and proves the bounded-retry recovery.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputActuator, SpawnSpec } from "../src/actuator";
import { SessionHub } from "../src/session";

/** Actuator that "eats" the Enter for the first N sends (live bug repro).
 *  On an honored send it asks the harness to fire the UserPromptSubmit ack. */
class FlakyActuator implements InputActuator {
  sends: string[] = [];
  private eats: number;
  constructor(
    eatFirstN: number,
    private onSubmitted: () => void,
  ) {
    this.eats = eatFirstN;
  }
  async spawn(_spec: SpawnSpec): Promise<void> {}
  async send(_name: string, text: string): Promise<void> {
    this.sends.push(text);
    if (this.eats > 0) {
      this.eats -= 1; // Enter eaten — composer holds the text, no submit
      return;
    }
    // Submit lands → the hook fires shortly after (async, like real curl).
    setTimeout(() => this.onSubmitted(), 10);
  }
  async interrupt(_name: string): Promise<void> {}
  async alive(_name: string): Promise<boolean> {
    return true;
  }
  async kill(_name: string): Promise<void> {}
}

function makeHub(): SessionHub {
  return new SessionHub({ socketPath: join(mkdtempSync(join(tmpdir(), "gen-cls-")), "c.sock") });
}

/** Fire the hook-surface user-message IR the way ControlServer would. */
function fireSubmitAck(hub: SessionHub, sessionId: string): void {
  hub.dispatch({
    kind: "message.user",
    sessionId,
    observedAt: Date.now(),
    surface: "hook",
    text: "the prompt",
  });
}

describe("closed-loop send (UserPromptSubmit ack)", () => {
  test("happy path: one send, ack arrives, no retries", async () => {
    const hub = makeHub();
    let actuator!: FlakyActuator;
    actuator = new FlakyActuator(0, () => fireSubmitAck(hub, session.sessionId));
    const session = await hub.createSession({
      cwd: "/x",
      actuator,
      bin: "claude",
      submitAckMs: 500,
    });
    await session.send("hello");
    expect(actuator.sends).toEqual(["hello"]);
  });

  test("eaten Enter (the live Telegram bug): bare-Enter retry recovers", async () => {
    const hub = makeHub();
    let actuator!: FlakyActuator;
    actuator = new FlakyActuator(1, () => fireSubmitAck(hub, session.sessionId));
    const session = await hub.createSession({
      cwd: "/x",
      actuator,
      bin: "claude",
      submitAckMs: 100,
    });
    await session.send("stranded prompt");
    // attempt 0: text+Enter (eaten) → ack miss → attempt 1: bare Enter → ack.
    expect(actuator.sends).toEqual(["stranded prompt", ""]);
  });

  test("ack never arrives: bounded retries then throw (no silent hang)", async () => {
    const hub = makeHub();
    const actuator = new FlakyActuator(99, () => {});
    const session = await hub.createSession({
      cwd: "/x",
      actuator,
      bin: "claude",
      submitAckMs: 50,
      submitRetries: 2,
    });
    await expect(session.send("never lands")).rejects.toThrow(/not acknowledged/);
    expect(actuator.sends).toEqual(["never lands", "", ""]); // 1 send + 2 bare-Enter retries
  });

  test("empty text (trust nudge) stays fire-and-forget — no ack wait", async () => {
    const hub = makeHub();
    const actuator = new FlakyActuator(99, () => {});
    const session = await hub.createSession({
      cwd: "/x",
      actuator,
      bin: "claude",
      submitAckMs: 5_000, // would hang the test if awaited
    });
    const start = Date.now();
    await session.send("");
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(actuator.sends).toEqual([""]);
  });
});
