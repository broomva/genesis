import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCaller } from "./voice";
import { VOICE_QUEUE_FILE, createVoiceQueue, parseVoicePrincipals } from "./voice-queue";

const dirs: string[] = [];
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "genesis-voiceq-")));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ticket = (over: Record<string, unknown> = {}) => ({
  id: "t-1",
  callerId: "573017758620",
  deliverTo: "573017758620",
  request: "please send me the invoice",
  createdAt: "2026-08-23T01:00:00.000Z",
  ...over,
});

describe("parseVoicePrincipals — must produce ids resolveCaller can actually match", () => {
  test("an absent or blank value is an empty list, never a crash", () => {
    expect(parseVoicePrincipals(undefined)).toEqual([]);
    expect(parseVoicePrincipals("")).toEqual([]);
    expect(parseVoicePrincipals("   ,  , ")).toEqual([]);
  });

  test("bare numbers parse, with no name", () => {
    expect(parseVoicePrincipals("573017758620,573214994114")).toEqual([
      { id: "573017758620" },
      { id: "573214994114" },
    ]);
  });

  test("number:Name parses the name", () => {
    expect(parseVoicePrincipals("573017758620:Carlos")).toEqual([
      { id: "573017758620", name: "Carlos" },
    ]);
  });

  // The bug this whole normalization exists to prevent: an operator writes the
  // number the way a human writes it, and every caller silently resolves unknown.
  test("REGRESSION: a human-formatted number still matches a caller id", () => {
    const principals = parseVoicePrincipals("+57 301 775-8620:Carlos");
    expect(principals).toEqual([{ id: "573017758620", name: "Carlos" }]);
    const r = resolveCaller("+57 (301) 775 8620", principals);
    expect(r.kind).toBe("known");
  });

  test("a name containing a colon keeps its whole name", () => {
    expect(parseVoicePrincipals("573017758620:Carlos: on call")).toEqual([
      { id: "573017758620", name: "Carlos: on call" },
    ]);
  });

  test("an entry with no digits is DROPPED, not stored as an empty id", () => {
    // An empty id would be what normalizeCallerId yields for garbage, so keeping
    // it would put a principal in the list that collides with unparseable input.
    const principals = parseVoicePrincipals("not-a-number,573017758620");
    expect(principals).toEqual([{ id: "573017758620" }]);
    expect(principals.some((p) => p.id === "")).toBe(false);
  });

  test("a duplicate number is kept once, so entry order cannot change behaviour", () => {
    expect(parseVoicePrincipals("573017758620:First,573017758620:Second")).toEqual([
      { id: "573017758620", name: "First" },
    ]);
  });
});

describe("createVoiceQueue", () => {
  test("creates the directory and appends one JSON line per ticket", () => {
    const dir = join(tmp(), "nested", "voice");
    const enqueue = createVoiceQueue(dir);
    enqueue(ticket());
    enqueue(ticket({ id: "t-2", request: "second" }));

    const lines = readFileSync(join(dir, VOICE_QUEUE_FILE), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).id).toBe("t-1");
    expect(JSON.parse(lines[1] as string).request).toBe("second");
  });

  test("round-trips a ticket without losing the delivery target", () => {
    const dir = tmp();
    createVoiceQueue(dir)(ticket());
    const parsed = JSON.parse(readFileSync(join(dir, VOICE_QUEUE_FILE), "utf8").trim());
    expect(parsed.deliverTo).toBe("573017758620");
    expect(parsed.callerId).toBe("573017758620");
  });

  test("an unknown caller's ticket persists with NO deliverTo", () => {
    const dir = tmp();
    const { deliverTo: _omit, ...anonymous } = ticket();
    createVoiceQueue(dir)(anonymous as never);
    const parsed = JSON.parse(readFileSync(join(dir, VOICE_QUEUE_FILE), "utf8").trim());
    expect(parsed.deliverTo).toBeUndefined();
  });

  // The failure policy, asserted rather than described. printTrace swallows;
  // this must not, because /voice/request turns the throw into a 503 the agent
  // reads to the caller instead of promising a follow-up that will never come.
  test("a write failure PROPAGATES — it must not be swallowed like printTrace", () => {
    const dir = tmp();
    const enqueue = createVoiceQueue(dir);
    // Replace the queue file with a directory: appendFileSync then fails EISDIR.
    rmSync(join(dir, VOICE_QUEUE_FILE), { force: true });
    require("node:fs").mkdirSync(join(dir, VOICE_QUEUE_FILE), { recursive: true });
    expect(() => enqueue(ticket())).toThrow();
  });

  test("a pre-existing queue file is appended to, never truncated", () => {
    const dir = tmp();
    const file = join(dir, VOICE_QUEUE_FILE);
    createVoiceQueue(dir);
    writeFileSync(file, `${JSON.stringify(ticket({ id: "t-0" }))}\n`);
    createVoiceQueue(dir)(ticket({ id: "t-1" }));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).id).toBe("t-0");
  });
});
