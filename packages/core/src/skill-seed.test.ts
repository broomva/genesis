import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedSkills } from "./skill-seed";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skillseed-"));
  const src = join(root, "src");
  mkdirSync(join(src, "parallax"), { recursive: true });
  writeFileSync(join(src, "parallax", "SKILL.md"), "# parallax\n");
  writeFileSync(join(src, "parallax", "errors.txt"), "E01\n");
  return { root: join(root, "ws"), src };
}

describe("seedSkills — the safe half of 'a tenant can hold a skill' (BRO-2245)", () => {
  test("skills land in the tenant's .claude/skills", () => {
    // The capability BRO-2245 wanted, on the safe side of the line: a privileged
    // process installs them, so the tenant runs WITH the skill without ever being
    // able to write `.claude/` — where `allowed-tools:` frontmatter is a real
    // permission layer.
    const { root, src } = fixture();
    const r = seedSkills(root, { sourceDir: src });
    expect(r.written.length).toBe(2);
    expect(readFileSync(join(root, ".claude/skills/parallax/SKILL.md"), "utf8")).toBe(
      "# parallax\n",
    );
  });

  test("re-seeding is idempotent and does NOT clobber by default", () => {
    const { root, src } = fixture();
    seedSkills(root, { sourceDir: src });
    const again = seedSkills(root, { sourceDir: src });
    expect(again.written.length).toBe(0);
    expect(again.unchanged.length).toBe(2); // identical content is not a rewrite

    // A DIFFERING file is skipped, not overwritten — matching seedAgentStack, so a
    // re-provision cannot silently replace something an operator edited in place.
    writeFileSync(join(root, ".claude/skills/parallax/SKILL.md"), "# edited\n");
    const third = seedSkills(root, { sourceDir: src });
    expect(third.skipped).toContain(join(root, ".claude/skills/parallax/SKILL.md"));
    expect(readFileSync(join(root, ".claude/skills/parallax/SKILL.md"), "utf8")).toBe("# edited\n");
  });

  test("a traversal or hidden directory name is refused, not sanitised", () => {
    // The provisioner runs as ROOT against an operator-controlled directory. A name
    // it cannot vouch for is skipped rather than cleaned up into one that passes.
    const { root, src } = fixture();
    for (const bad of ["..", ".hidden", "Upper", "has space"]) {
      mkdirSync(join(src, bad), { recursive: true });
      writeFileSync(join(src, bad, "SKILL.md"), "x\n");
    }
    const r = seedSkills(root, { sourceDir: src });
    // POSITIVE CONTROL — the legitimate skill still seeded in the same run, so this
    // is not just "seedSkills refuses everything".
    expect(r.written.some((p) => p.includes("/parallax/"))).toBe(true);
    for (const bad of ["..", ".hidden", "Upper", "has space"]) {
      expect(r.written.some((p) => p.includes(`/${bad}/`))).toBe(false);
    }
  });

  test("only skill-shaped FILES are copied", () => {
    // An allowlist, not a blocklist: a root process copying arbitrary trees into a
    // tenant is how a source directory nobody audited becomes a delivery mechanism.
    const { root, src } = fixture();
    writeFileSync(join(src, "parallax", "run.sh"), "#!/bin/sh\n");
    writeFileSync(join(src, "parallax", "binary.so"), "\x00\x01");
    const r = seedSkills(root, { sourceDir: src });
    expect(r.written.some((p) => p.endsWith("SKILL.md"))).toBe(true);
    expect(r.written.some((p) => p.endsWith("run.sh"))).toBe(false);
    expect(r.written.some((p) => p.endsWith("binary.so"))).toBe(false);
  });

  test("a missing source directory seeds nothing and does not throw", () => {
    // Skills are optional. A provisioner that refused to run without them would be
    // worse than one that seeds none.
    const { root } = fixture();
    const r = seedSkills(root, { sourceDir: join(root, "nope") });
    expect(r.written).toEqual([]);
  });
});
