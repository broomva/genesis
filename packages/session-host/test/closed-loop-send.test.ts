// Closed-loop send tests (BRO-1485 #9) — the UserPromptSubmit hook as the
// actuator's submit-ack. Reproduces the live Telegram failure (Enter eaten →
// prompt stranded in the composer) and proves the bounded-retry recovery.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputActuator, SpawnSpec } from "../src/actuator";
import { SessionHub } from "../src/session";

/** Actuator that "eats" the submit for the first N sends (live bug repro).
 *  Models a WEDGED composer: a plain submit fails until the composer is
 *  cleared (clearFirst). On an honored send it fires the UserPromptSubmit ack
 *  with the text that ACTUALLY submitted. */
class FlakyActuator implements InputActuator {
  sends: string[] = [];
  /** Per-send opts seen (to assert clearFirst was used on retries). */
  clears: boolean[] = [];
  private eats: number;
  private composer = ""; // text stranded by an eaten submit
  constructor(
    eatFirstN: number,
    private onSubmitted: (text: string) => void,
  ) {
    this.eats = eatFirstN;
  }
  async spawn(_spec: SpawnSpec): Promise<void> {}
  async send(_name: string, text: string, opts?: { clearFirst?: boolean }): Promise<void> {
    this.sends.push(text);
    this.clears.push(opts?.clearFirst === true);
    if (opts?.clearFirst) this.composer = ""; // Escape + Ctrl-U cleared it
    this.composer += text;
    if (this.eats > 0) {
      this.eats -= 1; // submit eaten — composer holds the text, no ack
      return;
    }
    const submitted = this.composer;
    this.composer = "";
    setTimeout(() => this.onSubmitted(submitted), 10);
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
function fireSubmitAck(hub: SessionHub, sessionId: string, text: string): void {
  hub.dispatch({
    kind: "message.user",
    sessionId,
    observedAt: Date.now(),
    surface: "hook",
    text,
  });
}

describe("closed-loop send (UserPromptSubmit ack)", () => {
  test("happy path: one send, ack arrives, no retries", async () => {
    const hub = makeHub();
    let sessionId = "";
    const actuator = new FlakyActuator(0, (text) => fireSubmitAck(hub, sessionId, text));
    const session = await hub.createSession({
      cwd: "/x",
      actuator,
      bin: "claude",
      submitAckMs: 500,
    });
    sessionId = session.sessionId;
    await session.send("hello");
    expect(actuator.sends).toEqual(["hello"]);
  });

  test("wedged composer (the live bug): clear+retype retry recovers (BRO-1494)", async () => {
    const hub = makeHub();
    let sessionId = "";
    const actuator = new FlakyActuator(1, (text) => fireSubmitAck(hub, sessionId, text));
    const session = await hub.createSession({
      cwd: "/x",
      actuator,
      bin: "claude",
      submitAckMs: 100,
    });
    sessionId = session.sessionId;
    await session.send("stranded prompt");
    // attempt 0: type+submit (wedged) → ack miss → attempt 1: clear+RETYPE → ack.
    expect(actuator.sends).toEqual(["stranded prompt", "stranded prompt"]);
    expect(actuator.clears).toEqual([false, true]); // retry cleared the composer
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
    // 1 type + 2 clear+retype retries (full text each, clearFirst on retries).
    expect(actuator.sends).toEqual(["never lands", "never lands", "never lands"]);
    expect(actuator.clears).toEqual([false, true, true]);
  });

  test("transcript-surface message.user does NOT ack (replay safety, P20 c.3)", async () => {
    const hub = makeHub();
    const actuator = new FlakyActuator(99, () => {});
    const session = await hub.createSession({
      cwd: "/x",
      actuator,
      bin: "claude",
      submitAckMs: 60,
      submitRetries: 0,
    });
    const pending = session.send("replay bait");
    // A transcript-replay user message (daemon-restart recovery) must not ack.
    hub.dispatch({
      kind: "message.user",
      sessionId: session.sessionId,
      observedAt: Date.now(),
      surface: "transcript",
      text: "replay bait",
    });
    await expect(pending).rejects.toThrow(/not acknowledged/);
  });

  test("ack requires the EXACT submitted text (no cross-send false ack, P20 c.1)", async () => {
    const hub = makeHub();
    const actuator = new FlakyActuator(99, () => {});
    const session = await hub.createSession({
      cwd: "/x",
      actuator,
      bin: "claude",
      submitAckMs: 120,
      submitRetries: 0,
    });
    const pending = session.send("the real prompt");
    hub.dispatch({
      kind: "message.user",
      sessionId: session.sessionId,
      observedAt: Date.now(),
      surface: "hook",
      text: "some other prompt", // wrong text — must not consume the waiter
    });
    await Bun.sleep(20);
    hub.dispatch({
      kind: "message.user",
      sessionId: session.sessionId,
      observedAt: Date.now(),
      surface: "hook",
      text: "the real prompt", // exact match — acks
    });
    await pending; // resolves, no throw
  });

  test("kill() cancels in-flight send waiters (no grind against dead tmux)", async () => {
    const hub = makeHub();
    const actuator = new FlakyActuator(99, () => {});
    const session = await hub.createSession({
      cwd: "/x",
      actuator,
      bin: "claude",
      submitAckMs: 60_000, // would hang the test if not cancelled
      submitRetries: 0,
    });
    const pending = session.send("doomed");
    await Bun.sleep(10);
    await session.kill();
    await expect(pending).rejects.toThrow(/not acknowledged/);
  });

  test("concurrent sends serialize — no interleave, each gets its own ack (P20)", async () => {
    const hub = makeHub();
    let sessionId = "";
    // Honor every send; ack the actual submitted composer text.
    const actuator = new FlakyActuator(0, (text) => fireSubmitAck(hub, sessionId, text));
    const session = await hub.createSession({
      cwd: "/x",
      actuator,
      bin: "claude",
      submitAckMs: 500,
    });
    sessionId = session.sessionId;
    // Fire two sends "concurrently" — the mutex must run them one at a time.
    await Promise.all([session.send("first"), session.send("second")]);
    // Both submitted, in order, with no bare-Enter interleaving between them.
    expect(actuator.sends).toEqual(["first", "second"]);
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
