import { describe, expect, test } from "bun:test";
import { Hub } from "./hub";

describe("hub", () => {
  test("reclaims the thread entry when the last listener unsubscribes (no map leak)", () => {
    const hub = new Hub();
    const u1 = hub.subscribe("t", () => {});
    const u2 = hub.subscribe("t", () => {});
    expect(hub.size).toBe(1);
    u1();
    expect(hub.size).toBe(1); // still one listener
    u2();
    expect(hub.size).toBe(0); // reclaimed
  });

  test("a throwing listener does not abort delivery to the others", () => {
    const hub = new Hub();
    let got = 0;
    hub.subscribe("t", () => {
      throw new Error("dead socket");
    });
    hub.subscribe("t", () => {
      got++;
    });
    expect(() => hub.publish("t", { x: 1 })).not.toThrow();
    expect(got).toBe(1);
  });
});
