import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seedSkills } from "./skill-seed";

/** The repo's seeded-skill source. Whatever lives here is what every tenant
 *  workspace gets. */
const SOURCE = resolve(import.meta.dir, "../../../tenant-skills");

/** Seeding is an ALLOWLIST: `skill-seed.ts` copies only certain filenames and
 *  only accepts certain directory names. A skill that violates either is not
 *  rejected loudly — it is silently skipped, and the tenant simply never
 *  receives it. That is the failure this file exists to prevent: the whole
 *  point of these skills is that the agent does not know the channel's shape
 *  without them, and a silently-unseeded skill is indistinguishable from never
 *  having written one. */
describe("everything in tenant-skills/ actually reaches a tenant", () => {
  const dirs = readdirSync(SOURCE, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  test("there is at least one skill to seed", () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  test("every skill directory name is one the seeder will accept", () => {
    // SKILL_DIR_RE in skill-seed.ts. A capital letter or an underscore is
    // rejected there, not sanitised.
    for (const d of dirs) expect(d).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
  });

  test("every skill carries a SKILL.md", () => {
    for (const d of dirs) {
      const p = join(SOURCE, d, "SKILL.md");
      expect(statSync(p).isFile()).toBe(true);
    }
  });

  test("no skill file would be silently DROPPED by the copy allowlist", () => {
    // SKILL_FILE_RE: only .md/.txt/.json/.ya?ml are copied. A `scripts/run.sh`
    // placed here would vanish without a word — which is also why capability
    // must be installed in the environment rather than shipped in a skill.
    for (const d of dirs) {
      for (const e of readdirSync(join(SOURCE, d), { withFileTypes: true })) {
        expect(`${d}/${e.name}`).toBe(
          e.isFile() && /^[A-Za-z0-9._-]+\.(md|txt|json|ya?ml)$/.test(e.name)
            ? `${d}/${e.name}`
            : `${d}/<UNSEEDABLE: ${e.name}>`,
        );
      }
    }
  });

  test("seeding the REAL directory writes the REAL skills", () => {
    // Drives seedSkills itself rather than re-deriving its rules: a test that
    // reimplements the code under test drifts from it.
    const root = mkdtempSync(join(tmpdir(), "tenant-skills-"));
    try {
      const result = seedSkills(root, { sourceDir: SOURCE });
      expect(result.written.length).toBeGreaterThan(0);
      // Nothing INSIDE a skill directory may be skipped. A top-level file such
      // as this directory's README is legitimately skipped — only directories
      // are skills — so the assertion is scoped rather than blanket, which is
      // what makes it able to fail for the right reason.
      for (const d of dirs) {
        expect(result.skipped.filter((p) => p.includes(`/${d}/`))).toEqual([]);
      }
      for (const d of dirs) {
        expect(result.written.some((w) => w.includes(`${d}/SKILL.md`))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the whatsapp-channel skill states what the channel actually does", () => {
  const text = Bun.file(join(SOURCE, "whatsapp-channel", "SKILL.md"));

  test("it tells the agent it cannot send files", async () => {
    // The specific failure that prompted this: an agent produced an HTML report
    // and announced it, with no route for the operator to open it. If this
    // sentence ever stops being true, THIS TEST should be what fails — the file
    // must be updated in the same change that adds a delivery path, not later.
    const s = await text.text();
    expect(s).toMatch(/cannot send files/i);
  });

  test("it names the 24-hour window", async () => {
    expect(await text.text()).toMatch(/24 hours/i);
  });

  test("it warns that long replies are split", async () => {
    // \s+ because the source is hard-wrapped: the phrase spans a line break.
    expect(await text.text()).toMatch(/separate\s+messages/i);
  });
});
