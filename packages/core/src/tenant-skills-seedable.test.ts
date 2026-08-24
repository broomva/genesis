import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

describe("re-seeding semantics, and why the unsafe fix was reverted", () => {
  test("re-seeding replaces a stale file rather than skipping it", () => {
    // The blocker: seedSkills without `overwrite` SKIPS a file whose content
    // differs, so a corrected skill lands on newly-provisioned tenants and
    // silently never reaches existing ones. For a file whose purpose is telling
    // the agent facts about the channel, a stale copy is worse than none — it
    // is a confidently-stated falsehood the agent acts on.
    const root = mkdtempSync(join(tmpdir(), "reseed-"));
    try {
      const first = seedSkills(root, { sourceDir: SOURCE, overwrite: true });
      expect(first.written.length).toBeGreaterThan(0);

      // Simulate an operator edit by corrupting the seeded copy, then re-seed.
      const seeded = first.written[0] as string;
      writeFileSync(seeded, "STALE CONTENT");
      const second = seedSkills(root, { sourceDir: SOURCE, overwrite: true });

      expect(second.skipped.filter((p) => p.includes("/whatsapp-channel/"))).toEqual([]);
      expect(readFileSync(seeded, "utf8")).not.toBe("STALE CONTENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("WITHOUT overwrite the stale copy survives — the defect, pinned", () => {
    // Bidirectional proof: this asserts the failure mode is real, so the fix
    // above cannot be quietly reverted without a test going red.
    const root = mkdtempSync(join(tmpdir(), "reseed-no-"));
    try {
      const first = seedSkills(root, { sourceDir: SOURCE });
      const seeded = first.written[0] as string;
      writeFileSync(seeded, "STALE CONTENT");
      seedSkills(root, { sourceDir: SOURCE });
      expect(readFileSync(seeded, "utf8")).toBe("STALE CONTENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the PROVISIONER does NOT pass overwrite — pinned as a security decision", () => {
    // This assertion is INVERTED from what it first said, deliberately.
    //
    // overwrite:true was added to fix stale prose and then found to open a
    // root-write escape: readFileSync(dst) and chmodSync(dst) run BEFORE any
    // symlink check, and the skill directory sits under a 1775 group-writable
    // .claude, so an ANCESTOR can be tenant-controlled and a destination lstat
    // cannot see it. Reverted.
    //
    // The propagation problem is real and remains open on BRO-2309. This test
    // exists so the flag cannot come back quietly as an easy fix for it — the
    // safe route is openat/O_NOFOLLOW or write-to-temp-then-rename inside the
    // seeder, and whoever does that should be changing this line knowingly.
    const script = readFileSync(
      resolve(import.meta.dir, "../../../scripts/provision-whatsapp-tenants.ts"),
      "utf8",
    );
    const call = /seedSkills\(t\.dir, \{[\s\S]*?\}\)/.exec(script)?.[0] ?? "";
    expect(call).not.toBe("");
    expect(call).not.toContain("overwrite");
  });
});
