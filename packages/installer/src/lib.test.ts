import { describe, expect, test } from "bun:test";
import {
  type InstallInputs,
  detectOS,
  looksLikeToken,
  parseArgs,
  parseGetMe,
  paths,
  renderEnvSh,
  renderLaunchdPlist,
  renderSecretsEnv,
  renderStartScript,
  renderSystemdUnit,
  serviceId,
} from "./lib";

const inputs: InstallInputs = {
  os: "macos",
  home: "/Users/me",
  repoDir: "/Users/me/genesis",
  botToken: "12345:AAAA-token_value_aaaaaaaaaaaaaaaaaaaaaaaa",
  botUsername: "BroomvaGenesisBot",
  allowedUsers: "547052379",
  workspace: "/Users/me/work",
  port: 8842,
  pathDirs: ["/opt/homebrew/bin", "/Users/me/.bun/bin"],
};

describe("detectOS", () => {
  test("maps platforms", () => {
    expect(detectOS("darwin")).toBe("macos");
    expect(detectOS("linux")).toBe("linux");
  });
  test("rejects unsupported", () => {
    expect(() => detectOS("win32")).toThrow(/unsupported/);
  });
});

describe("paths", () => {
  test("macOS logs to Library/Logs, linux under config", () => {
    expect(paths("macos", "/Users/me").logDir).toBe("/Users/me/Library/Logs");
    expect(paths("linux", "/home/me").logDir).toBe("/home/me/.config/genesis-bot/logs");
    expect(paths("linux", "/home/me").secretsFile).toBe("/home/me/.config/genesis-bot/secrets.env");
  });
});

describe("renderSecretsEnv", () => {
  test("bare VAR=value, no export", () => {
    const s = renderSecretsEnv("12345:AAA");
    expect(s).toContain("TELEGRAM_BOT_TOKEN=12345:AAA");
    expect(s).not.toContain("export ");
  });
});

describe("renderEnvSh", () => {
  const p = paths("macos", inputs.home);
  const env = renderEnvSh(inputs, p);
  test("prepends tool dirs to PATH", () => {
    expect(env).toContain('export PATH="/opt/homebrew/bin:/Users/me/.bun/bin:$PATH"');
  });
  test("sets workspace, port, username, allowlist", () => {
    expect(env).toContain('export GENESIS_WORKSPACE="/Users/me/work"');
    expect(env).toContain("export PORT=8842");
    expect(env).toContain('export TELEGRAM_BOT_USERNAME="BroomvaGenesisBot"');
    expect(env).toContain("export GENESIS_TELEGRAM_ALLOWED_USERS=547052379");
  });
  test("sources the 0600 secrets file under set -a, not the token inline", () => {
    expect(env).toContain('source "/Users/me/.config/genesis-bot/secrets.env"');
    expect(env).toContain("set -a");
    expect(env).not.toContain(inputs.botToken);
  });
});

describe("renderStartScript", () => {
  const p = paths("macos", inputs.home);
  test("cd to repo + exec the right entry", () => {
    expect(renderStartScript(inputs, p, "api")).toContain("exec bun apps/api/src/index.ts");
    expect(renderStartScript(inputs, p, "bot")).toContain("exec bun apps/chat-bot/src/index.ts");
    expect(renderStartScript(inputs, p, "api")).toContain('cd "/Users/me/genesis"');
  });
});

describe("serviceId", () => {
  test("launchd label vs systemd unit", () => {
    expect(serviceId("macos", "api")).toBe("tech.broomva.genesis.api");
    expect(serviceId("linux", "bot")).toBe("genesis-bot.service");
  });
});

describe("renderLaunchdPlist", () => {
  const p = paths("macos", inputs.home);
  const plist = renderLaunchdPlist(inputs, p, "api");
  test("has label, RunAtLoad, KeepAlive, the start script, repo workdir", () => {
    expect(plist).toContain("<string>tech.broomva.genesis.api</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("/Users/me/.config/genesis-bot/start-api.sh");
    expect(plist).toContain("<string>/Users/me/genesis</string>");
  });
});

describe("renderSystemdUnit", () => {
  const lp = paths("linux", "/home/me");
  const li: InstallInputs = {
    ...inputs,
    os: "linux",
    home: "/home/me",
    repoDir: "/home/me/genesis",
  };
  test("api unit: restart, default.target, exec start", () => {
    const u = renderSystemdUnit(li, lp, "api");
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain("WantedBy=default.target");
    expect(u).toContain("ExecStart=/bin/bash /home/me/.config/genesis-bot/start-api.sh");
  });
  test("bot unit is ordered after the api", () => {
    const u = renderSystemdUnit(li, lp, "bot");
    expect(u).toContain("After=network-online.target\nAfter=genesis-api.service");
    expect(u).toContain("Wants=genesis-api.service");
  });
});

describe("parseGetMe", () => {
  test("ok → username", () => {
    expect(parseGetMe({ ok: true, result: { username: "BroomvaGenesisBot" } })).toEqual({
      ok: true,
      username: "BroomvaGenesisBot",
    });
  });
  test("not ok → reason from description", () => {
    expect(parseGetMe({ ok: false, description: "Unauthorized" })).toEqual({
      ok: false,
      reason: "Unauthorized",
    });
  });
  test("garbage → not ok", () => {
    expect(parseGetMe(null).ok).toBe(false);
    expect(parseGetMe("nope").ok).toBe(false);
  });
});

describe("looksLikeToken", () => {
  test("accepts a plausible token, rejects junk", () => {
    expect(looksLikeToken("8464126287:AAExampleExampleExampleExampleExampleX")).toBe(true);
    expect(looksLikeToken("not-a-token")).toBe(false);
    expect(looksLikeToken("12345:short")).toBe(false);
  });
});

describe("parseArgs", () => {
  test("--key=val, --key val, --flag, command", () => {
    const a = parseArgs(["install", "--token=abc", "--owner", "123", "--force"]);
    expect(a.command).toBe("install");
    expect(a.flags.token).toBe("abc");
    expect(a.flags.owner).toBe("123");
    expect(a.bools.has("force")).toBe(true);
  });
  test("defaults command to help", () => {
    expect(parseArgs([]).command).toBe("help");
  });
});
