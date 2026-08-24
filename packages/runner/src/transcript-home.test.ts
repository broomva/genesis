import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumableTranscriptExists } from "./interactive";

/** Plant a transcript the way Claude would, under an arbitrary home. */
function plant(home: string, cwd: string, sessionId: string) {
  const dir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), "{}\n");
}

// BRO-2235. This lookup used homedir() — the SERVER's home — while the spawned
// child writes under the HOME it was given. With per-tenant HOME those differ, and
// the disagreement is SILENT: the server finds nothing, spawns fresh every turn,
// and the tenant never remembers anything. No error is ever raised.
describe("resumableTranscriptExists honours an explicit home", () => {
  test("finds a transcript under the home it is GIVEN", () => {
    const home = mkdtempSync(join(tmpdir(), "th-"));
    plant(home, "/w/tenant", "sess-1");
    expect(resumableTranscriptExists("/w/tenant", "sess-1", home)).toBe(true);
  });

  // The regression itself: planted under the tenant home, looked up under the
  // server's. Before the fix this was unconditionally the server's home.
  test("does NOT find it under a DIFFERENT home", () => {
    const tenantHome = mkdtempSync(join(tmpdir(), "th-"));
    const serverHome = mkdtempSync(join(tmpdir(), "sh-"));
    plant(tenantHome, "/w/tenant", "sess-1");
    expect(resumableTranscriptExists("/w/tenant", "sess-1", serverHome)).toBe(false);
  });

  test("a missing transcript is false, not a throw (safe direction: fresh spawn)", () => {
    const home = mkdtempSync(join(tmpdir(), "th-"));
    expect(resumableTranscriptExists("/w/tenant", "nope", home)).toBe(false);
  });

  test("the slug rule still maps / and . to -", () => {
    const home = mkdtempSync(join(tmpdir(), "th-"));
    plant(home, "/w/a.b/c", "s");
    expect(resumableTranscriptExists("/w/a.b/c", "s", home)).toBe(true);
  });
});
