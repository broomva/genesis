import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STACK_AGENTS, agentMarkdown, seedAgentStack } from "./agent-stack";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "genesis-agent-stack-"));
}

describe("STACK_AGENTS", () => {
  test("carries the three stack agents, uniquely named", () => {
    const names = STACK_AGENTS.map((a) => a.name);
    expect(names).toEqual(["autonomous", "p9", "parallax"]);
    expect(new Set(names).size).toBe(names.length);
  });

  // The description is the ONLY thing a dispatching model reads when choosing an
  // agent. An empty or generic one makes the agent unreachable, which is a
  // failure that never shows up as an error anywhere.
  test("every agent has a substantive description and prompt", () => {
    for (const a of STACK_AGENTS) {
      expect(a.description.length).toBeGreaterThan(60);
      expect(a.prompt.trim().length).toBeGreaterThan(120);
    }
  });

  // Each body must stand on its own: a confined tenant may not have the skill
  // installed, and an agent whose entire content is "load the X skill" is inert
  // there. It should still POINT at the skill where one resolves.
  test("each agent names its own skill as canonical but does not depend on it", () => {
    for (const a of STACK_AGENTS) {
      expect(a.prompt).toContain(`\`${a.name}\` skill`);
      // More than the skill pointer: numbered operating steps.
      expect(a.prompt).toMatch(/^\d\.\s/m);
    }
  });
});

describe("agentMarkdown", () => {
  test("renders frontmatter Claude Code can parse", () => {
    const md = agentMarkdown({
      name: "probe",
      description: "A probe agent.",
      tools: ["Read", "Grep"],
      prompt: "Body text.",
    });
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("name: probe");
    expect(md).toContain("tools: Read, Grep");
    expect(md).toContain("Body text.");
    // Exactly two frontmatter fences, so the body is never swallowed into it.
    expect(md.split("\n").filter((l) => l === "---").length).toBe(2);
  });

  // A description containing a colon or a newline would break naive YAML. JSON
  // quoting is the reason this is a function and not a template literal.
  test("a description with YAML-hostile characters stays on one quoted line", () => {
    const md = agentMarkdown({
      name: "probe",
      description: 'Handles: refunds, "chargebacks"\nand more',
      prompt: "Body.",
    });
    const descLine = md.split("\n").find((l) => l.startsWith("description:"));
    expect(descLine).toBeDefined();
    expect(descLine).toContain("\\n");
    expect(descLine).not.toContain("\n");
    expect(JSON.parse(descLine?.slice("description: ".length) ?? "")).toBe(
      'Handles: refunds, "chargebacks"\nand more',
    );
  });

  test("omits the tools line entirely when the agent inherits the full set", () => {
    const md = agentMarkdown({ name: "p", description: "d", prompt: "b" });
    expect(md).not.toContain("tools:");
  });
});

describe("seedAgentStack", () => {
  test("creates .claude/agents and writes every stack agent", () => {
    const root = tmpRoot();
    const r = seedAgentStack(root);
    expect(r.dir).toBe(join(root, ".claude", "agents"));
    expect(r.written.length).toBe(STACK_AGENTS.length);
    expect(r.skipped).toEqual([]);
    for (const a of STACK_AGENTS) {
      const p = join(root, ".claude", "agents", `${a.name}.md`);
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p, "utf8")).toBe(agentMarkdown(a));
    }
  });

  test("is idempotent — a second call writes nothing and reports unchanged", () => {
    const root = tmpRoot();
    seedAgentStack(root);
    const second = seedAgentStack(root);
    expect(second.written).toEqual([]);
    expect(second.unchanged.length).toBe(STACK_AGENTS.length);
    expect(second.skipped).toEqual([]);
  });

  // BOTH POLARITIES. `.claude/agents` is group-writable in a tenant workspace by
  // design, so a re-provision that clobbered would delete the tenant's own work.
  // The negative case (default) must preserve; the positive case (overwrite)
  // must actually replace — a preserve-always implementation would pass the
  // first assertion alone.
  test("does NOT clobber a differing file, and reports it as skipped", () => {
    const root = tmpRoot();
    const dir = join(root, ".claude", "agents");
    mkdirSync(dir, { recursive: true });
    const mine = join(dir, "p9.md");
    writeFileSync(mine, "---\nname: p9\n---\nmy own p9\n");

    const r = seedAgentStack(root);

    expect(readFileSync(mine, "utf8")).toBe("---\nname: p9\n---\nmy own p9\n");
    expect(r.skipped).toEqual([mine]);
    expect(r.written.length).toBe(STACK_AGENTS.length - 1);
  });

  test("overwrite:true DOES replace a differing file", () => {
    const root = tmpRoot();
    const dir = join(root, ".claude", "agents");
    mkdirSync(dir, { recursive: true });
    const mine = join(dir, "p9.md");
    writeFileSync(mine, "stale\n");

    const r = seedAgentStack(root, { overwrite: true });

    const p9 = STACK_AGENTS.find((a) => a.name === "p9");
    if (!p9) throw new Error("fixture drift: no p9 in STACK_AGENTS");
    expect(readFileSync(mine, "utf8")).toBe(agentMarkdown(p9));
    expect(r.skipped).toEqual([]);
    expect(r.written).toContain(mine);
  });

  test("honours a caller-supplied agent set", () => {
    const root = tmpRoot();
    const r = seedAgentStack(root, {
      agents: [{ name: "solo", description: "d", prompt: "b" }],
    });
    expect(r.written.length).toBe(1);
    expect(existsSync(join(root, ".claude", "agents", "solo.md"))).toBe(true);
    expect(existsSync(join(root, ".claude", "agents", "p9.md"))).toBe(false);
  });

  // The tenant path writes 0444. A second provision run must not die on its own
  // previous output — this is the failure that would only appear on re-provision,
  // i.e. exactly when an operator is fixing something urgent.
  test("overwrite succeeds over a read-only file it previously wrote", () => {
    const root = tmpRoot();
    // mode-only ownership: uid/gid of this process, so the test needs no root.
    const own = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, mode: 0o444 };
    seedAgentStack(root, { ownership: own });
    const p = join(root, ".claude", "agents", "p9.md");
    chmodSync(p, 0o444);

    const r = seedAgentStack(root, {
      ownership: own,
      overwrite: true,
      agents: [{ name: "p9", description: "replaced", prompt: "new body" }],
    });

    expect(r.written).toEqual([p]);
    expect(readFileSync(p, "utf8")).toContain("new body");
  });
});
