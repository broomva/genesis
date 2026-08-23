import { describe, expect, test } from "bun:test";
import { denyRulesFor } from "./tenant-deny-rules";

// This file had NO tests before BRO-2236. That is not incidental: the two defects
// below are both the kind a hand-maintained list acquires silently and a green suite
// never notices.
describe("denyRulesFor — the file-tool boundary (BRO-2236)", () => {
  const HOME = "/home/agent";
  const DIR = "/home/agent/tenants/wa-573000000000";

  test("every protected path is denied for EVERY read verb, not just Read", () => {
    const rules = denyRulesFor(HOME, DIR);
    // The original list denied Read on .ssh/.aws/.config/.claude/*.env and Grep on
    // only broomva/ and genesis/. Grep returns matching CONTENT, so grepping ~/.ssh
    // or ~/*.env was never denied at all.
    for (const g of [".ssh/**", ".aws/**", ".config/**", ".claude/**", "*.env"]) {
      for (const verb of ["Read", "Grep", "Glob"]) {
        expect(rules).toContain(`${verb}(//home/agent/${g})`);
      }
    }
  });

  test("the operator's home is protected against WRITING, not only reading", () => {
    // The read asymmetry was only half of it. ~/.claude/** merges into EVERY Claude
    // Code session on the box, so a SessionStart hook written there executes as
    // `agent`, who holds NOPASSWD:ALL — and the file is owned by agent, so the OS
    // layer does not stop it either. Reading these paths is disclosure; writing them
    // is execution.
    const rules = denyRulesFor(HOME, DIR);
    for (const g of [".claude/**", "genesis/**", ".ssh/**", ".aws/**"]) {
      for (const verb of ["Edit", "Write", "NotebookEdit"]) {
        expect(rules).toContain(`${verb}(//home/agent/${g})`);
      }
    }
  });

  test("denying writes to HOME does not deny the tenant its OWN directory", () => {
    // POSITIVE CONTROL for the rule above: a tenant that cannot write its own
    // workspace is useless, and a deny list that broke that would still pass every
    // assertion in the previous test.
    const rules = denyRulesFor(HOME, DIR);
    const ownDirWrites = rules.filter(
      (r) => /^(Edit|Write|NotebookEdit)\(/.test(r) && r.includes(`${DIR.slice(1)}/`),
    );
    // The ONLY writes denied inside the tenant dir are its own .claude settings.
    expect(ownDirWrites.every((r) => r.includes("/.claude/**"))).toBe(true);
    expect(ownDirWrites.length).toBe(2);
  });

  test("the rules FOLLOW home — they are not hardcoded to /home/agent", () => {
    // The sandbox denyRead layer is derived from HOME. These rules were literals, so
    // pointing GENESIS_TENANT_HOME elsewhere left the two layers guarding different
    // directories while the file-tool channel is the ONLY boundary here.
    // The tenant dir moves WITH home here. Passing a /home/agent tenant dir would
    // make the negative assertion below fail on the Edit/Write rules, which legitimately
    // name the tenant's own directory — a false failure that says nothing about
    // whether the HOME-derived rules followed.
    const rules = denyRulesFor("/srv/genesis-home", "/srv/genesis-home/tenants/wa-1");
    expect(rules).toContain("Read(//srv/genesis-home/.ssh/**)");
    expect(rules).toContain("Grep(//srv/genesis-home/*.env)");
    expect(rules).toContain("Glob(//srv/genesis-home/.claude/**)");
    // NEGATIVE POLARITY — no rule may mention the old default, otherwise "follows
    // home" could pass while still emitting stale literals alongside the new ones.
    expect(rules.some((r) => r.includes("/home/agent"))).toBe(false);
  });

  test("the tenant cannot rewrite its own confinement, and that rule follows the tenant dir", () => {
    const rules = denyRulesFor(HOME, DIR);
    expect(rules).toContain(`Edit(//${DIR.slice(1)}/.claude/**)`);
    expect(rules).toContain(`Write(//${DIR.slice(1)}/.claude/**)`);
  });

  test("every rule uses the absolute // anchor", () => {
    // A single leading slash anchors at the settings file and matches NOTHING, so a
    // malformed anchor is a silently empty deny list.
    for (const r of denyRulesFor(HOME, DIR)) {
      expect(r).toMatch(/^[A-Za-z]+\(\/\/[^/]/);
    }
  });
});
