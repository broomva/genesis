import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A source assertion, matching apps/api/src/index-wiring.test.ts: the provisioner
// runs ~270 lines at import, so its generated settings cannot be unit-tested
// without provisioning. The value being guarded is a literal, so reading the
// source is a sound way to pin it.
const SRC = readFileSync(join(import.meta.dir, "provision-whatsapp-tenants.ts"), "utf8");

describe("tenant permission tiers (BRO-2245 x BRO-2236)", () => {
  test("no tier grants bypassPermissions", () => {
    // For the built-in file tools the permission MODE is the cage: they run
    // in-process and are not covered by sandbox.filesystem, and bypass auto-approves
    // every call except explicit deny rules — against a deny list that is a
    // blocklist. A tier promising "ungated inside the same cage" cannot use it.
    const modeLines = SRC.split("\n").filter((l) => l.includes("defaultMode:"));
    expect(modeLines.length).toBeGreaterThan(0); // the assertion must have a subject
    for (const l of modeLines) expect(l).not.toContain("bypassPermissions");
  });

  test("the trusted tier still EXISTS and still differs from the default one", () => {
    // POSITIVE CONTROL. Without this, deleting the tier entirely would satisfy the
    // test above — "no tier grants bypass" is trivially true when there are no tiers.
    const line = SRC.split("\n").find((l) => l.includes("defaultMode:") && l.includes("?"));
    expect(line).toBeDefined();
    expect(line).toContain('"trusted"');
    expect(line).toContain("acceptEdits");
    expect(line).toContain('"default"');
  });
});
