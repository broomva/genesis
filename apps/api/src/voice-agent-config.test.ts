import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
  // Each entry is a way of committing the caller to a future contact. `followUp`
  // is "none" today for every caller, so any of these spoken aloud is a promise
  // nothing in the tree can keep.
  const PROMISES = [
    "whatsapp",
    "get back to you",
    "follow up with you",
    "will message you",
    "call you back",
    "text you",
    "reach out to you",
  ];

  test.each(PROMISES)("the prompt never commits to %p", (phrase) => {
    expect(prompt.toLowerCase()).not.toContain(phrase);
  });

  test("the prompt defers to the followUp field rather than deciding itself", () => {
    expect(prompt).toContain("followUp");
    expect(prompt.toLowerCase()).toContain("only authority");
  });

  test("the prompt forbids naming a channel followUp did not name", () => {
    expect(prompt.toLowerCase()).toContain("never name a delivery channel");
  });

  test("the prompt refuses to greet by name, since caller id is spoofable", () => {
    // /voice/identify stopped returning the name for exactly this reason; an
    // agent that greeted by name from any other source would reopen the leak.
    expect(prompt.toLowerCase()).toContain("do not greet anyone by name");
  });

  test("the prompt never claims a tool result it did not get", () => {
    expect(prompt.toLowerCase()).toContain("never claim something was recorded");
  });
});

describe("committed configs carry no live credentials or ids", () => {
  test("no config contains an ElevenLabs-looking key", () => {
    for (const e of [...agentsIndex.agents, ...toolsIndex.tools]) {
      const raw = readFileSync(join(EL, e.config), "utf8");
      expect(raw).not.toMatch(/sk_[a-z0-9]{20,}/i);
    }
  });

  test("tool_ids is empty in the committed agent — the provisioner fills it", () => {
    // Hardcoding ids here would push an agent bound to tools from someone else's
    // workspace, which fails in a way that looks like the tools are broken.
    expect(agent.conversation_config.agent.prompt.tool_ids).toEqual([]);
  });
});
