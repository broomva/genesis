import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_COMMANDS,
  controlAction,
  enumerateSessionCommands,
  renderCommandList,
  renderHelp,
} from "./commands";

describe("controlAction", () => {
  test("maps control commands + aliases to actions", () => {
    expect(controlAction("new")).toBe("new");
    expect(controlAction("reset")).toBe("new");
    expect(controlAction("clear")).toBe("new");
    expect(controlAction("stop")).toBe("stop");
    expect(controlAction("cancel")).toBe("stop");
    expect(controlAction("status")).toBe("status");
    expect(controlAction("commands")).toBe("commands");
    expect(controlAction("skills")).toBe("commands");
    expect(controlAction("help")).toBe("help");
    expect(controlAction("start")).toBe("help");
  });
  test("is case-insensitive and rejects non-control commands", () => {
    expect(controlAction("NEW")).toBe("new");
    expect(controlAction("autonomous")).toBeUndefined(); // a skill → forwarded
    expect(controlAction("model")).toBeUndefined(); // built-in → engine declines
    expect(controlAction("randomthing")).toBeUndefined();
  });
});

describe("enumerateSessionCommands", () => {
  function fakeSkillsDir(skills: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "gen-skills-"));
    for (const [name, description] of Object.entries(skills)) {
      mkdirSync(join(dir, name));
      writeFileSync(
        join(dir, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: "${description}"\n---\n`,
      );
    }
    return dir;
  }

  test("discovers skills from dirs with parsed descriptions + built-ins", () => {
    const dir = fakeSkillsDir({
      ArXiv: "Search arXiv papers. Lots more detail here that should be trimmed.",
      Research: "Deep multi-source research.",
    });
    const cmds = enumerateSessionCommands({ skillsDirs: [dir] });
    const names = cmds.map((c) => c.name);
    expect(names).toContain("arxiv");
    expect(names).toContain("research");
    expect(names).toContain("model"); // built-in present
    const arxiv = cmds.find((c) => c.name === "arxiv");
    expect(arxiv?.kind).toBe("skill");
    expect(arxiv?.description).toBe("Search arXiv papers."); // first sentence only
  });

  test("a non-skill directory entry is skipped, sorted output, no dupes", () => {
    const dir = fakeSkillsDir({ Zed: "Z skill.", Alpha: "A skill." });
    const cmds = enumerateSessionCommands({ skillsDirs: [dir] });
    const skillNames = cmds.filter((c) => c.kind === "skill").map((c) => c.name);
    expect(skillNames).toEqual(["alpha", "zed"]); // sorted
  });

  test("missing skills dir → just built-ins, never throws", () => {
    const cmds = enumerateSessionCommands({ skillsDirs: ["/no/such/dir"] });
    expect(cmds.every((c) => c.kind === "builtin")).toBe(true);
    expect(cmds.length).toBeGreaterThan(0);
  });
});

describe("rendering", () => {
  test("renderCommandList lists built-ins and skill names under Telegram's cap", () => {
    const out = renderCommandList([
      { name: "model", description: "switch model", kind: "builtin" },
      { name: "arxiv", description: "papers", kind: "skill" },
      { name: "research", description: "research", kind: "skill" },
    ]);
    expect(out).toContain("/model");
    expect(out).toContain("/arxiv");
    expect(out).toContain("Skills (2)");
    expect(out.length).toBeLessThan(4096);
  });
  test("renderHelp mentions every control command", () => {
    const help = renderHelp();
    for (const c of CONTROL_COMMANDS) expect(help).toContain(`/${c.command}`);
  });
});
