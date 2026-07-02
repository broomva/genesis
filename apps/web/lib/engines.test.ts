import { afterEach, describe, expect, test } from "bun:test";
import type { SelectOption } from "./chat-options";
import { fetchAvailableEngines, gateEngineOptions, isEngineAvailable } from "./engines";

const origFetch = global.fetch;
afterEach(() => {
  global.fetch = origFetch;
});

const ALL: readonly SelectOption[] = [
  { value: "interactive", label: "Interactive" },
  { value: "print", label: "Print" },
  { value: "codex", label: "Codex" },
];

describe("gateEngineOptions (BRO-1622)", () => {
  test("marks options not in the advertised set as disabled", () => {
    const gated = gateEngineOptions(ALL, ["interactive", "print"]); // no codex on this box
    expect(gated.find((o) => o.value === "interactive")?.disabled).toBe(false);
    expect(gated.find((o) => o.value === "print")?.disabled).toBe(false);
    expect(gated.find((o) => o.value === "codex")?.disabled).toBe(true);
  });

  test("advertised === null → degrade OPEN (every option enabled)", () => {
    const gated = gateEngineOptions(ALL, null);
    expect(gated.every((o) => !o.disabled)).toBe(true);
    expect(gated.map((o) => o.value)).toEqual(["interactive", "print", "codex"]);
  });

  test("all advertised → none disabled", () => {
    const gated = gateEngineOptions(ALL, ["interactive", "print", "codex"]);
    expect(gated.every((o) => o.disabled === false)).toBe(true);
  });
});

describe("isEngineAvailable (BRO-1622)", () => {
  test("true when advertised or when the set is unknown (degrade open)", () => {
    expect(isEngineAvailable("codex", ["interactive", "codex"])).toBe(true);
    expect(isEngineAvailable("codex", null)).toBe(true); // unknown → assume available
  });
  test("false when a known set excludes it", () => {
    expect(isEngineAvailable("codex", ["interactive", "print"])).toBe(false);
  });
});

describe("fetchAvailableEngines (BRO-1622)", () => {
  function stub(ok: boolean, body: unknown, opts?: { throws?: boolean }): void {
    global.fetch = (async () => {
      if (opts?.throws) throw new Error("network down");
      return { ok, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  test("returns the advertised engine array", async () => {
    stub(true, { engines: ["interactive", "print", "codex"], defaultEngine: "interactive" });
    expect(await fetchAvailableEngines()).toEqual(["interactive", "print", "codex"]);
  });

  test("drops malformed entries; empty → null (degrade open)", async () => {
    stub(true, { engines: ["print", "", 42, null] });
    expect(await fetchAvailableEngines()).toEqual(["print"]);
    stub(true, { engines: [] });
    expect(await fetchAvailableEngines()).toBeNull();
  });

  test("non-ok / thrown / non-array → null (degrade open)", async () => {
    stub(false, { error: "unauthorized" });
    expect(await fetchAvailableEngines()).toBeNull();
    stub(true, { engines: "nope" });
    expect(await fetchAvailableEngines()).toBeNull();
    stub(true, {}, { throws: true });
    expect(await fetchAvailableEngines()).toBeNull();
  });
});
