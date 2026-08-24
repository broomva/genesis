import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentStateUnder,
  assertCredentialed,
  assertHomeOutsideTenant,
  assertNoStrandedAgentState,
  isInside,
  projectSlug,
} from "./tenant-home";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "tenant-home-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("projectSlug — matches Claude Code's on-disk naming", () => {
  // Both verified against the live box's ~/.claude/projects listing.
  test("a tenant workspace path", () =>
    expect(projectSlug("/home/agent/orchestrator-workspaces/573017758620")).toBe(
      "-home-agent-orchestrator-workspaces-573017758620",
    ));
  test("a dotted segment collapses too, producing the double dash", () =>
    expect(projectSlug("/home/agent/.p20probe")).toBe("-home-agent--p20probe"));
});

describe("assertCredentialed — fail-closed, and not satisfiable by a placeholder", () => {
  const seed = (make: (claude: string) => void) => {
    const home = tmp();
    const claude = join(home, ".claude");
    mkdirSync(claude, { recursive: true });
    make(claude);
    return home;
  };

  test("a real, non-empty credential passes", () => {
    const home = seed((c) => writeFileSync(join(c, ".credentials.json"), '{"t":1}'));
    expect(() => assertCredentialed(home)).not.toThrow();
  });

  test("missing → refuses", () => {
    const home = seed(() => {});
    expect(() => assertCredentialed(home)).toThrow(/missing, empty, or not a file/);
  });

  // The two `existsSync` would have accepted. Both are artifacts that satisfy the
  // check's letter while proving nothing about a usable credential.
  test("a ZERO-BYTE credential → refuses", () => {
    const home = seed((c) => writeFileSync(join(c, ".credentials.json"), ""));
    expect(() => assertCredentialed(home)).toThrow(/missing, empty, or not a file/);
  });

  test("a DIRECTORY named .credentials.json → refuses", () => {
    const home = seed((c) => mkdirSync(join(c, ".credentials.json")));
    expect(() => assertCredentialed(home)).toThrow(/missing, empty, or not a file/);
  });
});

describe("assertNoStrandedAgentState — over-refusing is the intended failure mode", () => {
  const withProjects = (entries: string[]) => {
    const oldHome = tmp();
    const root = join(oldHome, ".claude", "projects");
    mkdirSync(root, { recursive: true });
    for (const e of entries) mkdirSync(join(root, e), { recursive: true });
    return oldHome;
  };
  const DIR = "/home/agent/orchestrator-workspaces/573017758620";

  test("no projects root at all → nothing stranded", () => {
    expect(() => assertNoStrandedAgentState(tmp(), "/t/home", DIR)).not.toThrow();
  });

  test("an unrelated tenant's transcripts do not block this one", () => {
    const oldHome = withProjects(["-home-agent-orchestrator-workspaces-999999999999"]);
    expect(() => assertNoStrandedAgentState(oldHome, "/t/home", DIR)).not.toThrow();
  });

  test("the exact slug → refuses, and names the move", () => {
    const oldHome = withProjects(["-home-agent-orchestrator-workspaces-573017758620"]);
    expect(() => assertNoStrandedAgentState(oldHome, "/t/home", DIR)).toThrow(/would strand/);
    expect(() => assertNoStrandedAgentState(oldHome, "/t/home", DIR)).toThrow(/mv .*projects/);
  });

  // THE DELIBERATE FALSE POSITIVE. A `-backup` sibling is not the tenant's real
  // transcript dir, and the confinement eval was fixed to stop matching exactly
  // this shape — because there a false positive invented a breach. Here the costs
  // are inverted: a missed directory silently breaks --resume, an extra one only
  // asks a human. Loose matching is the correct bias, and this pins it so a future
  // "consistency" edit to exact-matching has to argue with a test.
  test("a look-alike sibling ALSO refuses — a false positive is the safe error", () => {
    const oldHome = withProjects(["-home-agent-orchestrator-workspaces-573017758620-backup"]);
    expect(() => assertNoStrandedAgentState(oldHome, "/t/home", DIR)).toThrow(/would strand/);
  });

  test("agentStateUnder reports every candidate, not just the first", () => {
    const oldHome = withProjects([
      "-home-agent-orchestrator-workspaces-573017758620",
      "-home-agent-orchestrator-workspaces-573017758620-backup",
      "-home-agent-orchestrator-workspaces-999999999999",
    ]);
    expect(agentStateUnder(oldHome, DIR).sort()).toEqual([
      "-home-agent-orchestrator-workspaces-573017758620",
      "-home-agent-orchestrator-workspaces-573017758620-backup",
    ]);
  });
});

describe("isInside — separator-aware, not a prefix test", () => {
  test("a path inside is inside", () =>
    expect(isInside("/home/agent/ws/573", "/home/agent/ws/573/home")).toBe(true));
  test("the same path counts as inside", () =>
    expect(isInside("/home/agent/ws/573", "/home/agent/ws/573")).toBe(true));
  // A bare startsWith says `/a/b` contains `/a/bc`. It does not, and getting this
  // wrong in the permissive direction is what the guard exists to prevent.
  test("a SIBLING sharing a prefix is NOT inside", () =>
    expect(isInside("/home/agent/ws/573", "/home/agent/ws/5731/home")).toBe(false));
  test("a genuinely separate tree is not inside", () =>
    expect(isInside("/home/agent/ws/573", "/home/agent/.config/homes/573")).toBe(false));
  test("relative segments are resolved before comparing", () =>
    expect(isInside("/home/agent/ws/573", "/home/agent/ws/573/../573/home")).toBe(true));
});

describe("assertHomeOutsideTenant — the self-inflicted hole", () => {
  const DIR = "/home/agent/orchestrator-workspaces/573017758620";

  // This is exactly what the first version of the feature did.
  test("a home under the tenant workspace REFUSES", () =>
    expect(() => assertHomeOutsideTenant(join(DIR, "home"), DIR)).toThrow(
      /inside the tenant's own workspace/,
    ));

  test("the tenant dir itself as HOME refuses", () =>
    expect(() => assertHomeOutsideTenant(DIR, DIR)).toThrow(/inside the tenant's own workspace/));

  test("a home outside the workspace passes", () =>
    expect(() =>
      assertHomeOutsideTenant("/home/agent/.config/genesis-bot/tenant-homes/573017758620", DIR),
    ).not.toThrow());

  test("a prefix-sharing sibling is not mistaken for containment", () =>
    expect(() =>
      assertHomeOutsideTenant("/home/agent/orchestrator-workspaces/5730177586200/home", DIR),
    ).not.toThrow());
});
