import { describe, expect, test } from "bun:test";
import { webhookPort } from "./webhook-port";

describe("webhookPort — a bad value must not become a random port (BRO-2216)", () => {
  test("the REACHABLE defect: set-but-empty is refused, not silently 0", () => {
    // `GENESIS_BOT_WEBHOOK_PORT=` in a sourced env file, or systemd
    // Environment="GENESIS_BOT_WEBHOOK_PORT=". "" is not nullish so `??` never
    // fired, and Number("") is 0 — which Bun accepts and turns into an ephemeral
    // port while the process reports healthy.
    expect(webhookPort("")).toBeUndefined();
    expect(webhookPort("   ")).toBeUndefined();
  });

  test("non-integers are refused rather than becoming NaN", () => {
    for (const bad of ["8788x", "-1", "80.5", "0x1f", "eighty", "80,80"]) {
      expect(webhookPort(bad)).toBeUndefined();
    }
  });

  test("0 is refused — 'any free port' is never what a fixed webhook wants", () => {
    expect(webhookPort("0")).toBeUndefined();
    expect(webhookPort("65536")).toBeUndefined();
  });

  test("POSITIVE CONTROLS — valid values still work, and unset still defaults", () => {
    // Without these, every assertion above would also pass on a function that
    // returns undefined unconditionally.
    expect(webhookPort(undefined)).toBe(8788);
    expect(webhookPort("8788")).toBe(8788);
    expect(webhookPort(" 9000 ")).toBe(9000);
    expect(webhookPort("1")).toBe(1);
    expect(webhookPort("65535")).toBe(65535);
  });
});
