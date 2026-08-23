import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The ElevenLabs agent is the other half of the /voice/* contract, and it lives
// in JSON that no compiler and no route test can see. That matters more here than
// it usually would: four P20 rounds went into making it IMPOSSIBLE for this
// surface to promise a follow-up it cannot deliver — and every one of those fixes
// can be undone by one sentence in a prompt file. The vendor config is where the
// invariant is easiest to break and hardest to notice.
//
// NOTE ON THIS TEST'S OWN SHAPE: the forbidden phrases below appear in THIS file,
// which is exactly how a self-referential check flags its own rule. It is safe
// only because the scan is scoped to the config files and never to itself, and
// because the prompt states its prohibition WITHOUT quoting the phrasing it
// forbids. If someone adds a "never say X" example to the prompt, this test will
// fail on it — that is a true positive about a brittle prompt, not a bug here.

const ROOT = join(import.meta.dir, "..", "..", "..");
const EL = join(ROOT, "integrations", "elevenlabs");
const read = (p: string) => JSON.parse(readFileSync(join(EL, p), "utf8"));

const agentsIndex = read("agents.json");
const toolsIndex = read("tools.json");
const agent = read(agentsIndex.agents[0].config);
const prompt: string = agent.conversation_config.agent.prompt.prompt;

describe("ElevenLabs tool configs point at the real Genesis surface", () => {
  test("every index entry resolves to a config that exists", () => {
    for (const e of [...agentsIndex.agents, ...toolsIndex.tools]) {
      expect(() => read(e.config)).not.toThrow();
    }
  });

  test.each([
    ["genesis-voice-identify.json", "/voice/identify", ["callerId"]],
    ["genesis-voice-request.json", "/voice/request", ["callerId", "request", "conversationId"]],
  ])("%s targets %s and sends the right body", (file, path, fields) => {
    const t = read(join("tool_configs", file));
    expect(t.type).toBe("webhook");
    expect(t.api_schema.method).toBe("POST");
    expect(t.api_schema.url).toBe(`\${GENESIS_PUBLIC_URL}${path}`);
    for (const f of fields)
      expect(Object.keys(t.api_schema.request_body_schema.properties)).toContain(f);
  });

  test("both tools present the shared secret, and it is a PLACEHOLDER", () => {
    // A literal secret here would be committed credentials. The provisioner
    // substitutes into a temp copy precisely so this file never holds one.
    for (const e of toolsIndex.tools) {
      const t = read(e.config);
      expect(t.api_schema.request_headers["x-genesis-voice-secret"]).toBe(
        "${GENESIS_VOICE_SECRET}",
      );
    }
  });

  test("the caller id is bound to the provider variable, not invented by the LLM", () => {
    for (const e of toolsIndex.tools) {
      const t = read(e.config);
      expect(t.api_schema.request_body_schema.properties.callerId.dynamic_variable).toBe(
        "system__caller_id",
      );
    }
  });

  test("conversationId is bound, so a retry collapses onto one ticket", () => {
    const t = read(join("tool_configs", "genesis-voice-request.json"));
    expect(t.api_schema.request_body_schema.properties.conversationId.dynamic_variable).toBe(
      "system__conversation_id",
    );
  });
});

describe("the agent prompt cannot promise what the system cannot do", () => {
  // EVERY string in the config, not just prompt.prompt. The first version of this
  // scanned one field, so the identical promise placed in `first_message` — which
  // the caller hears BEFORE anything else — passed untouched. Walking the whole
  // config also means a field added by a future CLI version is covered the day it
  // appears rather than the day someone remembers to add it here.
  const strings = (v: unknown, acc: string[] = []): string[] => {
    if (typeof v === "string") acc.push(v);
    else if (Array.isArray(v)) for (const x of v) strings(x, acc);
    else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, acc);
    return acc;
  };
  const allText = strings(agent);

  test("the walker actually reaches the fields that matter", () => {
    // A scan over an empty list passes everything. Pin that it found both the
    // prompt and the greeting, or the assertions below are vacuous.
    expect(allText).toContain(prompt);
    expect(allText).toContain(agent.conversation_config.agent.first_message);
    expect(allText.length).toBeGreaterThan(5);
  });

  // A blocklist is a FLOOR, never a ceiling — it catches the phrasings we thought
  // of. The regex below is the part that generalizes.
  const PHRASES = [
    "whatsapp",
    "get back to you",
    "follow up with you",
    "will message you",
    "call you back",
    "text you",
    "reach out to you",
    "contact you",
    "send you",
    "let you know",
  ];

  test.each(PHRASES)("no field commits to %p", (phrase) => {
    const hit = allText.find((t) => t.toLowerCase().includes(phrase));
    expect(hit ?? "").not.toContain(phrase);
  });

  // The generalization: a first-person future commitment aimed at the caller.
  // Catches "we will contact you", "I'll send you the answer", "we are going to
  // get someone to call you" — phrasings no word list would have enumerated.
  // Deliberately anchored on we/I so the prompt's own second-person instructions
  // ("say plainly that you will take it down") are not false positives.
  const COMMITMENT = /\b(we|i)\s*('ll|'re|\s+(will|shall|are going to|can))\b[^.!?]{0,80}\byou\b/i;

  test("no field makes a first-person future commitment to the caller", () => {
    const offenders = allText.filter((t) => COMMITMENT.test(t));
    expect(offenders).toEqual([]);
  });

  test("the commitment regex is not vacuous — it fires on a real promise", () => {
    // Without this, a broken regex would report the config clean forever.
    expect(COMMITMENT.test("We will contact you with the answer later.")).toBe(true);
    expect(COMMITMENT.test("I'll send you a summary shortly.")).toBe(true);
    expect(COMMITMENT.test("We are going to have someone ring you back.")).toBe(true);
    // ...and does not fire on the second-person instructions the prompt needs.
    expect(COMMITMENT.test("say plainly that you will take it down")).toBe(false);
    expect(COMMITMENT.test("I've written that down for you.")).toBe(false);
  });

  test("the prompt defers to the followUp field rather than deciding itself", () => {
    expect(prompt).toContain("followUp");
    expect(prompt.toLowerCase()).toContain("only authority");
  });

  test("the prompt forbids naming a channel followUp did not name", () => {
    expect(prompt.toLowerCase()).toContain("never name a delivery channel");
  });

  test("the prompt refuses to greet by name, since caller id is spoofable", () => {
    expect(prompt.toLowerCase()).toContain("do not greet anyone by name");
  });

  test("the prompt never claims a tool result it did not get", () => {
    expect(prompt.toLowerCase()).toContain("never claim something was recorded");
  });
});

describe("committed configs carry no live credentials or ids", () => {
  // EVERY json under integrations/elevenlabs, not just the ones an index points
  // at: a config dropped in the directory but not yet indexed is exactly the file
  // someone pastes a working key into while trying things out.
  const allConfigs = (readdirSync(EL, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(EL, f));

  test("the sweep actually found the config files", () => {
    expect(allConfigs.length).toBeGreaterThanOrEqual(5);
  });

  test.each([
    ["ElevenLabs key", /\bsk_[A-Za-z0-9]{20,}/],
    ["ElevenLabs xi key", /\bxi-api-key['":\s]+[A-Za-z0-9]{20,}/i],
    ["bearer token", /\bBearer\s+[A-Za-z0-9._-]{20,}/],
    ["long hex secret", /\b[a-f0-9]{40,}\b/i],
    ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ])("no config contains a %s", (_label, pattern) => {
    for (const f of allConfigs) {
      expect(readFileSync(f, "utf8")).not.toMatch(pattern);
    }
  });

  test("the secret header is still a PLACEHOLDER in every tool config", () => {
    for (const e of toolsIndex.tools) {
      const t = read(e.config);
      expect(t.api_schema.request_headers["x-genesis-voice-secret"]).toBe(
        "${GENESIS_VOICE_SECRET}",
      );
    }
  });

  test("tool_ids is empty in the committed agent — the provisioner fills it", () => {
    // Hardcoding ids here would push an agent bound to tools from someone else's
    // workspace, which fails in a way that looks like the tools are broken.
    expect(agent.conversation_config.agent.prompt.tool_ids).toEqual([]);
  });
});
