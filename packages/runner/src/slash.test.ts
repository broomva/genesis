import { describe, expect, test } from "bun:test";
import { interceptSlashCommand } from "./slash";

describe("interceptSlashCommand", () => {
  test("intercepts built-in TUI commands (the /model live incident)", () => {
    for (const cmd of ["/model", "/clear", "/resume", "/config", "/agents", "/mcp"]) {
      const reply = interceptSlashCommand(cmd);
      expect(reply).toBeDefined();
      expect(reply).toContain(cmd.slice(1));
      expect(reply).toContain("terminal command");
    }
  });

  test("intercepts a command with trailing args", () => {
    expect(interceptSlashCommand("/model opus")).toBeDefined();
    expect(interceptSlashCommand("/clear   ")).toBeDefined();
  });

  test("intercepts with surrounding whitespace", () => {
    expect(interceptSlashCommand("  /model  ")).toBeDefined();
  });

  test("does NOT intercept normal prompts", () => {
    expect(interceptSlashCommand("what's in this repo?")).toBeUndefined();
    expect(interceptSlashCommand("explain the model architecture")).toBeUndefined();
  });

  test("does NOT intercept file paths or prose containing a slash (no false positive)", () => {
    expect(interceptSlashCommand("/tmp/foo is the path")).toBeUndefined();
    expect(interceptSlashCommand("read /etc/hosts for me")).toBeUndefined();
    expect(interceptSlashCommand("the ratio is 3/4")).toBeUndefined();
  });

  test("does NOT intercept skill-style slash commands (they produce a turn)", () => {
    // /autonomous, /checkit etc. inject a prompt → Stop fires → engine observes
    // them normally. Only built-in overlay/print commands are intercepted.
    expect(interceptSlashCommand("/autonomous")).toBeUndefined();
    expect(interceptSlashCommand("/checkit https://example.com")).toBeUndefined();
  });

  test("is case-insensitive on the command token", () => {
    expect(interceptSlashCommand("/MODEL")).toBeDefined();
    expect(interceptSlashCommand("/Clear")).toBeDefined();
  });

  test("hyphenated tokens that merely START with a command are NOT intercepted", () => {
    // greedy [a-z0-9-]* makes the token "cost-benefit", not "cost".
    expect(interceptSlashCommand("/cost-benefit analysis")).toBeUndefined();
    expect(interceptSlashCommand("/clear-the-cache please")).toBeUndefined();
    expect(interceptSlashCommand("/model-railway hobby")).toBeUndefined();
  });

  test("a command on the first line of a multi-line message is intercepted", () => {
    // First-token match still fires; the rest is irrelevant (we refuse anyway).
    expect(interceptSlashCommand("/model\nand also summarize the repo")).toBeDefined();
  });

  test("init and review are NOT intercepted (they double as workspace skills)", () => {
    expect(interceptSlashCommand("/init")).toBeUndefined();
    expect(interceptSlashCommand("/review the diff")).toBeUndefined();
  });

  test("compact is NOT intercepted (it triggers a summarization turn)", () => {
    expect(interceptSlashCommand("/compact")).toBeUndefined();
  });

  test("empty / bare slash is not a command", () => {
    expect(interceptSlashCommand("")).toBeUndefined();
    expect(interceptSlashCommand("/")).toBeUndefined();
    expect(interceptSlashCommand("/ leading space then text")).toBeUndefined();
  });
});
