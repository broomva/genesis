// Skills seeded into a tenant workspace's `.claude/skills` BY THE PROVISIONER.
//
// WHY THIS EXISTS. BRO-2245 wanted a tenant to be able to hold a skill, and did it
// by narrowing the `.claude/**` write-deny so the tenant could author one. That was
// reverted: `allowed-tools:` frontmatter is installed as a real permission layer and
// `.claude/agents/*.md` carries `permissionMode`/`tools`, so a tenant-writable
// `.claude/` is a permission escalation at the DEFAULT tier — no `trusted` needed.
//
// This is the capability restored on the safe side of that line, and it is the same
// shape `seedAgentStack` already uses for agents: a PRIVILEGED process installs the
// files, root-owned and read-only, and the tenant runs with them without ever being
// able to rewrite them. The tenant gets the skill; nobody gets the permission layer.
//
// The operator chooses the content by pointing GENESIS_TENANT_SKILLS_DIR at a
// directory. That directory is read by the provisioner (running as root), never by
// the tenant, so a skill can be updated for every tenant in one place.

import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SeedOwnership, SeedResult } from "./agent-stack";

/** A skill is a directory holding SKILL.md plus whatever it references. Only these
 *  files are copied: an allowlist rather than a blocklist, because a skills source
 *  directory is operator-controlled but not necessarily operator-audited, and a
 *  provisioner running as root should not copy arbitrary trees into a tenant. */
const SKILL_FILE_RE = /^[A-Za-z0-9._-]+\.(md|txt|json|ya?ml)$/;

/** A skill directory name we are willing to create inside the tenant. Rejects
 *  traversal and hidden names outright rather than sanitising them. */
const SKILL_DIR_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface SkillSeedOptions {
  /** Where the skills come from. Read by the PROVISIONER, not the tenant. */
  readonly sourceDir: string;
  /** Apply ownership/mode after writing. Root-only; omitted in tests. */
  readonly ownership?: SeedOwnership;
  /** Replace a file whose content differs. Default false: a re-provision must not
   *  clobber, matching seedAgentStack. */
  readonly overwrite?: boolean;
}

/** Copy the operator's skills into `<rootPath>/.claude/skills`.
 *
 *  Returns the same shape as `seedAgentStack` so a caller can report both the same
 *  way. A missing sourceDir is not an error: skills are optional, and a provisioner
 *  that refused to run without them would be worse than one that seeds none. */
export function seedSkills(rootPath: string, opts: SkillSeedOptions): SeedResult {
  const dir = join(rootPath, ".claude", "skills");
  const written: string[] = [];
  const unchanged: string[] = [];
  const skipped: string[] = [];

  if (!existsSync(opts.sourceDir)) return { dir, written, unchanged, skipped };

  for (const name of readdirSync(opts.sourceDir)) {
    const from = join(opts.sourceDir, name);
    if (!SKILL_DIR_RE.test(name) || !statSync(from).isDirectory()) {
      skipped.push(from);
      continue;
    }
    const to = join(dir, name);
    mkdirSync(to, { recursive: true });
    for (const file of readdirSync(from)) {
      const src = join(from, file);
      if (!SKILL_FILE_RE.test(file) || !statSync(src).isFile()) {
        skipped.push(src);
        continue;
      }
      const dst = join(to, file);
      const body = readFileSync(src, "utf8");
      if (existsSync(dst)) {
        let current = "";
        try {
          current = readFileSync(dst, "utf8");
        } catch {
          // Unreadable — treat as differing.
        }
        if (current === body) {
          unchanged.push(dst);
          continue;
        }
        if (!opts.overwrite) {
          skipped.push(dst);
          continue;
        }
        if (opts.ownership) {
          try {
            chmodSync(dst, 0o644); // a previous seed wrote this 0444
          } catch {
            // Not ours to chmod — the write below throws and the caller sees it.
          }
        }
      }
      // NEVER write through a symlink. This process is ROOT, and `overwrite`
      // turned what used to be a skip into a write — so a destination symlink
      // would have root follow it and then chown/chmod the target. The seeded
      // directory is not tenant-writable today, so this is defence in depth
      // rather than a live hole, but a privileged writer must not depend on the
      // permissions of a directory it does not itself enforce. (P20 BLOCKER.)
      if (lstatSync(dst, { throwIfNoEntry: false })?.isSymbolicLink()) {
        skipped.push(dst);
        continue;
      }
      writeFileSync(dst, body);
      if (opts.ownership) {
        chownSync(dst, opts.ownership.uid, opts.ownership.gid);
        chmodSync(dst, opts.ownership.mode);
      }
      written.push(dst);
    }
  }

  return { dir, written, unchanged, skipped };
}
