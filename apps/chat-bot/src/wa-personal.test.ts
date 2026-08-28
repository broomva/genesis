import { describe, expect, test } from "bun:test";
import { formatWaPrincipal, isSelfChat, waJidPrincipal } from "./wa-personal";

describe("waJidPrincipal — namespace separation", () => {
  // THE load-bearing test. If these two ever compare equal, an arbitrary LID
  // authorizes an allowlisted phone number.
  test("identical digits in PN and LID namespaces are DIFFERENT principals", () => {
    const pn = waJidPrincipal("573001234567@s.whatsapp.net");
    const lid = waJidPrincipal("573001234567@lid");

    expect(pn).toEqual({ ns: "pn", id: "573001234567" });
    expect(lid).toEqual({ ns: "lid", id: "573001234567" });
    expect(pn).not.toEqual(lid);
    expect(formatWaPrincipal(pn!)).not.toBe(formatWaPrincipal(lid!));
  });

  test("canonical form carries the namespace tag", () => {
    expect(formatWaPrincipal(waJidPrincipal("573001234567@s.whatsapp.net")!)).toBe("pn:573001234567");
    expect(formatWaPrincipal(waJidPrincipal("199999@lid")!)).toBe("lid:199999");
  });
});

describe("waJidPrincipal — JID shape handling", () => {
  test("strips the device suffix", () => {
    expect(waJidPrincipal("573001234567:7@s.whatsapp.net")).toEqual({ ns: "pn", id: "573001234567" });
    expect(waJidPrincipal("199999:3@lid")).toEqual({ ns: "lid", id: "199999" });
  });

  test("strips the agent suffix", () => {
    expect(waJidPrincipal("573001234567_1@s.whatsapp.net")).toEqual({ ns: "pn", id: "573001234567" });
  });

  test("strips device and agent together", () => {
    expect(waJidPrincipal("573001234567_1:7@s.whatsapp.net")).toEqual({ ns: "pn", id: "573001234567" });
  });

  test("legacy c.us server maps into the pn namespace", () => {
    expect(waJidPrincipal("573001234567@c.us")).toEqual({ ns: "pn", id: "573001234567" });
  });

  test("server comparison is case-insensitive", () => {
    expect(waJidPrincipal("573001234567@S.WhatsApp.Net")).toEqual({ ns: "pn", id: "573001234567" });
  });

  test("surrounding whitespace is tolerated", () => {
    expect(waJidPrincipal("  573001234567@s.whatsapp.net  ")).toEqual({ ns: "pn", id: "573001234567" });
  });
});

describe("waJidPrincipal — denials", () => {
  test.each([
    ["group", "120363000000000000@g.us"],
    ["broadcast", "status@broadcast"],
    ["newsletter", "120363000000000000@newsletter"],
    ["hosted", "573001234567@hosted"],
    ["hosted lid", "573001234567@hosted.lid"],
    ["unknown server", "573001234567@example.com"],
  ])("denies %s", (_label, jid) => {
    expect(waJidPrincipal(jid)).toBeUndefined();
  });

  test.each([
    ["empty string", ""],
    ["no @", "573001234567"],
    ["empty user part", "@s.whatsapp.net"],
    ["non-digit user", "abc@s.whatsapp.net"],
    ["mixed user", "5730abc@s.whatsapp.net"],
    ["device only", ":7@s.whatsapp.net"],
  ])("denies malformed input: %s", (_label, jid) => {
    expect(waJidPrincipal(jid)).toBeUndefined();
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
  ])("denies %s", (_label, jid) => {
    expect(waJidPrincipal(jid as undefined | null)).toBeUndefined();
  });
});

describe("isSelfChat", () => {
  test("matches the account's own chat across device suffixes", () => {
    expect(isSelfChat("573001234567@s.whatsapp.net", "573001234567:7@s.whatsapp.net")).toBe(true);
    expect(isSelfChat("573001234567:2@s.whatsapp.net", "573001234567@s.whatsapp.net")).toBe(true);
  });

  test("a different number is not self-chat", () => {
    expect(isSelfChat("573009999999@s.whatsapp.net", "573001234567:7@s.whatsapp.net")).toBe(false);
  });

  // Same digits, different namespace -> NOT self. Mirrors the collision test.
  test("same digits in the other namespace is not self-chat", () => {
    expect(isSelfChat("573001234567@lid", "573001234567@s.whatsapp.net")).toBe(false);
  });

  test("a group is never self-chat", () => {
    expect(isSelfChat("120363000000000000@g.us", "573001234567@s.whatsapp.net")).toBe(false);
  });

  test("unresolvable inputs are not self-chat", () => {
    expect(isSelfChat(undefined, "573001234567@s.whatsapp.net")).toBe(false);
    expect(isSelfChat("573001234567@s.whatsapp.net", undefined)).toBe(false);
    expect(isSelfChat(undefined, undefined)).toBe(false);
  });
});
