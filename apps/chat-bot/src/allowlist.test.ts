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
