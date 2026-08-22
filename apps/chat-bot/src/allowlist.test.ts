import { describe, expect, test } from "bun:test";
import { parseAllowlist, principalOf, startupGate, startupGateFor } from "./allowlist";

// Real Kapso thread ids. Literal base64url, NOT built with the same helper the
// implementation uses — a fixture encoded by the code under test would pass
// even if both sides were wrong together. These were produced independently
// (node -e 'Buffer.from(s).toString("base64url")') and match the shape in
// @kapso/chat-adapter@0.1.1 dist/index.js `encodeThreadId`:
//   kapso:<b64url(phoneNumberId)>:<b64url(waId)>[:<b64url(conversationId)>]
const OUR_NUMBER = "MTIzNDU2"; // "123456"      — our phoneNumberId
const OWNER_WA = "NTczMDAxMjM0NTY3"; // "573001234567" — owner's WhatsApp
const STRANGER_WA = "NTczMDA5OTk5OTk5"; // "573009999999" — someone else
const CONV = "Y29udi1hYmM"; // "conv-abc"

const KAPSO_OWNER = `kapso:${OUR_NUMBER}:${OWNER_WA}`;
const KAPSO_OWNER_4 = `kapso:${OUR_NUMBER}:${OWNER_WA}:${CONV}`;
const KAPSO_STRANGER = `kapso:${OUR_NUMBER}:${STRANGER_WA}`;

// --------------------------------------------------------------- regression
// Everything below this line is the pre-BRO-2216 contract, unchanged. If the
// multi-channel generalization broke single-channel Telegram config, these fail.

describe("parseAllowlist", () => {
  test("unset/empty → open (allow all, sandbox posture)", () => {
    for (const raw of [undefined, "", "   ", ",, ,"]) {
      const a = parseAllowlist(raw);
      expect(a.open).toBe(true);
      expect(a.allows("telegram:anything")).toBe(true);
    }
  });

  test("set → enforced; matches full thread id and bare chat id", () => {
    const a = parseAllowlist("547052379");
    expect(a.open).toBe(false);
    expect(a.allows("telegram:547052379")).toBe(true); // bare id matches thread id
    expect(a.allows("547052379")).toBe(true);
    expect(a.allows("telegram:999")).toBe(false);
    expect(a.allows("telegram:5470523790")).toBe(false); // no partial/substring match
  });

  test("full thread id entries also work", () => {
    const a = parseAllowlist("telegram:547052379, telegram:111");
    expect(a.allows("telegram:547052379")).toBe(true);
    expect(a.allows("telegram:111")).toBe(true);
    expect(a.allows("telegram:222")).toBe(false);
  });

  test("whitespace + multiple entries are tolerated", () => {
    const a = parseAllowlist("  547052379 , 111 ");
    expect(a.allows("telegram:547052379")).toBe(true);
    expect(a.allows("telegram:111")).toBe(true);
  });
});

describe("startupGate (fail-closed, BRO-1534)", () => {
  test("empty allowlist + no opt-out → REFUSE to start", () => {
    for (const raw of [undefined, "", "  "]) {
      const d = startupGate(raw, false);
      expect(d.action).toBe("refuse");
      if (d.action === "refuse") expect(d.reason).toMatch(/RCE-by-DM/);
    }
  });

  test("empty allowlist + GENESIS_ALLOW_OPEN=1 → serve OPEN", () => {
    const d = startupGate("", true);
    expect(d.action).toBe("serve");
    if (d.action === "serve") {
      expect(d.open).toBe(true);
      expect(d.allowlist.allows("telegram:anyone")).toBe(true);
    }
  });

  test("configured allowlist → serve ENFORCED (opt-out irrelevant)", () => {
    const d = startupGate("547052379", false);
    expect(d.action).toBe("serve");
    if (d.action === "serve") {
      expect(d.open).toBe(false);
      expect(d.allowlist.allows("telegram:547052379")).toBe(true);
      expect(d.allowlist.allows("telegram:999")).toBe(false);
    }
  });
});

// ------------------------------------------------------------ BRO-2216 new

describe("principalOf — Kapso thread ids are base64url, not plain", () => {
  test("decodes the SENDER (waId, part 2), not our own number", () => {
    expect(principalOf(KAPSO_OWNER, "kapso")).toEqual({
      channel: "kapso",
      id: "573001234567",
    });
  });

  test("the optional conversationId part does not change the principal", () => {
    expect(principalOf(KAPSO_OWNER_4, "kapso")).toEqual(principalOf(KAPSO_OWNER, "kapso") as never);
  });

  test("our own phoneNumberId is NOT the principal", () => {
    // Part 1 is identical on every inbound message. If it were the principal,
    // one allowlist entry would authorize every WhatsApp sender on earth.
    const p = principalOf(KAPSO_STRANGER, "kapso");
    expect(p?.id).toBe("573009999999");
    expect(p?.id).not.toBe("123456");
  });

  test("unparseable thread ids are DENIED, not defaulted", () => {
    for (const bad of [
      "kapso:onlytwo", // too few parts
      "kapso:a:b:c:d:e", // too many parts
      "kapso:MTIzNDU2:!!!notb64!!!", // non-base64url waId
      "kapso:MTIzNDU2:", // empty waId
      "slack:whatever", // channel we do not know
      "", // empty
      "   ",
    ]) {
      expect(principalOf(bad, "kapso")).toBeUndefined();
    }
  });

  test("a non-canonical base64url encoding is rejected", () => {
    // "=" is caught by the charset test, so it does NOT exercise the round-trip
    // check — a mutation sweep found this fixture proved nothing.
    expect(principalOf("kapso:MTIzNDU2:NTczMDAxMjM0NTY3=", "kapso")).toBeUndefined();

    // This one does. It passes the charset, and Node's lenient decoder yields
    // the SAME "573001234567" as the canonical NTczMDAxMjM0NTY3 (the trailing
    // bits are simply dropped). Only re-encoding catches it. Without that,
    // several distinct thread-id strings alias to one authorized principal —
    // permissive, not restrictive, so it is worth denying.
    expect(principalOf("kapso:MTIzNDU2:NTczMDAxMjM0NTY3A", "kapso")).toBeUndefined();
  });
});

describe("phone normalization — one principal per human", () => {
  test("formatting variants of the same number all match", () => {
    for (const written of [
      "573001234567",
      "+573001234567",
      "+57 300 123 4567",
      "+57-300-123-4567",
      "(57) 300 1234567",
    ]) {
      const a = parseAllowlist(written, "kapso");
      expect(a.allows(KAPSO_OWNER)).toBe(true);
    }
  });

  test("a different number still does not match", () => {
    const a = parseAllowlist("+573001234567", "kapso");
    expect(a.allows(KAPSO_STRANGER)).toBe(false);
  });
});

describe("cross-channel confusion is impossible", () => {
  test("a Telegram entry does not authorize a WhatsApp sender with the same digits", () => {
    // The pre-BRO-2216 matcher sliced after the first colon and compared bare
    // ids, so a bare entry authorized every channel at once.
    const a = parseAllowlist("573001234567", "telegram");
    expect(a.allows("telegram:573001234567")).toBe(true);
    expect(a.allows(KAPSO_OWNER)).toBe(false);
  });

  test("a WhatsApp entry does not authorize a Telegram chat with the same digits", () => {
    const a = parseAllowlist("573001234567", "kapso");
    expect(a.allows(KAPSO_OWNER)).toBe(true);
    expect(a.allows("telegram:573001234567")).toBe(false);
  });

  test("explicit channel prefixes bind to the named channel, whatever the var", () => {
    const a = parseAllowlist("kapso:+573001234567", "telegram");
    expect(a.allows(KAPSO_OWNER)).toBe(true);
    expect(a.allows("telegram:573001234567")).toBe(false);
  });
});

describe("decide — a refusal says why (the anti-corridor control)", () => {
  test("a listed principal is allowed", () => {
    expect(parseAllowlist("+573001234567", "kapso").decide(KAPSO_OWNER)).toEqual({
      allowed: true,
    });
  });

  test("understood but not listed → not-listed (the control working)", () => {
    expect(parseAllowlist("+573001234567", "kapso").decide(KAPSO_STRANGER)).toEqual({
      allowed: false,
      reason: "not-listed",
    });
  });

  test("could not be parsed → unresolvable (the control unable to evaluate)", () => {
    // This is the case that used to be indistinguishable from "not-listed",
    // making a misconfigured gate look like a dead bot.
    expect(parseAllowlist("+573001234567", "kapso").decide("kapso:broken")).toEqual({
      allowed: false,
      reason: "unresolvable",
    });
  });

  test("an open allowlist allows without a reason", () => {
    expect(parseAllowlist(undefined).decide("anything")).toEqual({ allowed: true });
  });

  test("across channels: one channel understanding it means not-listed, not unresolvable", () => {
    const d = startupGateFor(
      [
        { channel: "telegram", envVar: "TG", raw: "547052379" },
        { channel: "kapso", envVar: "WA", raw: "+573001234567" },
      ],
      false,
    );
    expect(d.action).toBe("serve");
    if (d.action !== "serve") return;
    // Kapso understands it and declines; Telegram cannot parse it. The union
    // must report the control working, not a malfunction.
    expect(d.allowlist.decide(KAPSO_STRANGER)).toEqual({
      allowed: false,
      reason: "not-listed",
    });
    // Nothing can parse this one.
    expect(d.allowlist.decide("slack:whoever")).toEqual({
      allowed: false,
      reason: "unresolvable",
    });
  });

  test("allows() stays consistent with decide()", () => {
    const a = parseAllowlist("+573001234567", "kapso");
    for (const t of [KAPSO_OWNER, KAPSO_STRANGER, "kapso:broken", "telegram:1"]) {
      expect(a.allows(t)).toBe(a.decide(t).allowed);
    }
  });
});

describe("startupGateFor — every REGISTERED channel is gated (BRO-2216)", () => {
  const TG = { channel: "telegram", envVar: "GENESIS_TELEGRAM_ALLOWED_USERS" } as const;
  const WA = { channel: "kapso", envVar: "GENESIS_WHATSAPP_ALLOWED_USERS" } as const;

  test("Telegram configured but WhatsApp registered-and-empty → REFUSE", () => {
    // The defect a global gate would have: one configured channel satisfies the
    // check while the other serves the world.
    const d = startupGateFor(
      [
        { ...TG, raw: "547052379" },
        { ...WA, raw: undefined },
      ],
      false,
    );
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") {
      expect(d.reason).toMatch(/GENESIS_WHATSAPP_ALLOWED_USERS/);
      expect(d.reason).not.toMatch(/GENESIS_TELEGRAM_ALLOWED_USERS/);
    }
  });

  test("both configured → serve ENFORCED, each channel matching only its own", () => {
    const d = startupGateFor(
      [
        { ...TG, raw: "547052379" },
        { ...WA, raw: "+573001234567" },
      ],
      false,
    );
    expect(d.action).toBe("serve");
    if (d.action === "serve") {
      expect(d.open).toBe(false);
      expect(d.allowlist.allows("telegram:547052379")).toBe(true);
      expect(d.allowlist.allows(KAPSO_OWNER)).toBe(true);
      expect(d.allowlist.allows(KAPSO_STRANGER)).toBe(false);
      expect(d.allowlist.allows("telegram:999")).toBe(false);
      // The union must not leak: the Telegram id is not a Kapso principal.
      expect(d.allowlist.allows("kapso:MTIzNDU2:NTQ3MDUyMzc5")).toBe(false);
    }
  });

  test("empty channel list → refuse (nothing to serve)", () => {
    expect(startupGateFor([], false).action).toBe("refuse");
    expect(startupGateFor([], true).action).toBe("refuse");
  });

  test("GENESIS_ALLOW_OPEN=1 still opens both, explicitly", () => {
    const d = startupGateFor(
      [
        { ...TG, raw: undefined },
        { ...WA, raw: undefined },
      ],
      true,
    );
    expect(d.action).toBe("serve");
    if (d.action === "serve") expect(d.open).toBe(true);
  });
});

describe("Allowlist.principals — per-tenant provisioning input (BRO-2224)", () => {
  test("an OPEN list enumerates NOTHING, even though it authorizes everyone", () => {
    // The contract the startup check depends on. If an open list instead
    // returned some plausible set, the caller would provision those tenants,
    // report success, and then serve every OTHER sender from the engine
    // default — confinement reported but not held.
    const open = parseAllowlist(undefined, "kapso");
    expect(open.open).toBe(true);
    expect(open.principals).toEqual([]);
    expect(open.allows("kapso:MTIzNDU2:NTczMDAxMjM0NTY3")).toBe(true);
  });

  test("enumerates each configured principal, channel-qualified", () => {
    const list = parseAllowlist("+57 300 123 4567, 573009999999", "kapso");
    expect(list.principals).toEqual([
      { channel: "kapso", id: "573001234567" },
      { channel: "kapso", id: "573009999999" },
    ]);
  });

  test("the same principal written twice is provisioned ONCE", () => {
    // Two spellings of one number must not yield two tenant directories — the
    // second would be created, verified, and then never used.
    const list = parseAllowlist("+57 300 123 4567, 573001234567", "kapso");
    expect(list.principals).toEqual([{ channel: "kapso", id: "573001234567" }]);
  });

  test("an unparseable entry contributes no principal", () => {
    expect(parseAllowlist("kapso:, ,573001234567", "kapso").principals).toEqual([
      { channel: "kapso", id: "573001234567" },
    ]);
  });

  test("startupGateFor unions channels without collapsing digit collisions", () => {
    // Same digits on two channels are two principals and must stay two
    // tenants; collapsing them would put a Telegram user and a WhatsApp sender
    // in one directory.
    const d = startupGateFor(
      [
        { channel: "telegram", raw: "573001234567", envVar: "T" },
        { channel: "kapso", raw: "573001234567", envVar: "W" },
      ],
      false,
    );
    expect(d.action).toBe("serve");
    if (d.action !== "serve") return;
    expect(d.allowlist.principals).toEqual([
      { channel: "telegram", id: "573001234567" },
      { channel: "kapso", id: "573001234567" },
    ]);
  });
});
