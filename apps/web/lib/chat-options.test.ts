// Provider-aware model/effort accessors (BRO-1623). These are load-bearing for
// the cross-provider guarantee — a claude alias must never be shown for / sent to
// codex, nor an OpenAI model for claude — so they're pinned here directly (P20).

import { describe, expect, test } from "bun:test";
import {
  CODEX_EFFORT_OPTIONS,
  CODEX_MODEL_OPTIONS,
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  contextWindowFor,
  effortOptionsFor,
  engineProvider,
  engineShowsEffort,
  engineShowsModel,
  modelIsSpawnPinned,
  modelOptionsFor,
  sanitizeEffortFor,
  sanitizeModelFor,
  workspaceShowsPicker,
  workspaceToBody,
} from "./chat-options";

describe("engineProvider", () => {
  test("codex → openai; everything else → anthropic", () => {
    expect(engineProvider("codex")).toBe("openai");
    expect(engineProvider("print")).toBe("anthropic");
    expect(engineProvider("interactive")).toBe("anthropic");
  });
});

describe("provider option sets", () => {
  test("modelOptionsFor / effortOptionsFor follow the provider", () => {
    expect(modelOptionsFor("codex")).toBe(CODEX_MODEL_OPTIONS);
    expect(modelOptionsFor("print")).toBe(MODEL_OPTIONS);
    expect(effortOptionsFor("codex")).toBe(CODEX_EFFORT_OPTIONS);
    expect(effortOptionsFor("interactive")).toBe(EFFORT_OPTIONS);
  });
});

describe("engineShowsModel / engineShowsEffort / modelIsSpawnPinned", () => {
  test("model selector hidden for codex (single model), shown for claude engines", () => {
    expect(engineShowsModel("codex")).toBe(false); // only gpt-5.5 → dead 1-option control
    expect(engineShowsModel("print")).toBe(true);
    expect(engineShowsModel("interactive")).toBe(true);
  });

  test("effort hidden for interactive (no per-launch knob), shown for print + codex", () => {
    expect(engineShowsEffort("interactive")).toBe(false);
    expect(engineShowsEffort("print")).toBe(true);
    expect(engineShowsEffort("codex")).toBe(true);
  });

  test("only interactive pins the model at spawn", () => {
    expect(modelIsSpawnPinned("interactive")).toBe(true);
    expect(modelIsSpawnPinned("print")).toBe(false);
    expect(modelIsSpawnPinned("codex")).toBe(false);
  });
});

describe("sanitizeModelFor — the cross-provider clamp", () => {
  test("a claude alias is clamped to the codex default (never reaches codex)", () => {
    expect(sanitizeModelFor("opus", "codex")).toBe("default");
    expect(sanitizeModelFor("sonnet", "codex")).toBe("default");
  });

  test("a claude alias is kept for a claude engine", () => {
    expect(sanitizeModelFor("opus", "print")).toBe("opus");
    expect(sanitizeModelFor("sonnet", "interactive")).toBe("sonnet");
  });

  test("an unknown model falls back to the provider default", () => {
    expect(sanitizeModelFor("totally-made-up", "print")).toBe("default");
  });
});

describe("sanitizeEffortFor — the cross-provider clamp", () => {
  test("claude-only 'max'/'xhigh' is clamped to standard for codex", () => {
    expect(sanitizeEffortFor("max", "codex")).toBe("standard");
    expect(sanitizeEffortFor("xhigh", "codex")).toBe("standard");
  });

  test("'minimal' (rejected by gpt-5.5) is clamped to standard for codex", () => {
    expect(sanitizeEffortFor("minimal", "codex")).toBe("standard");
  });

  test("a value valid for BOTH providers is preserved across the clamp", () => {
    expect(sanitizeEffortFor("high", "codex")).toBe("high");
    expect(sanitizeEffortFor("high", "print")).toBe("high");
    expect(sanitizeEffortFor("standard", "codex")).toBe("standard"); // sentinel in both
  });

  test("codex keeps its own levels; print keeps its own 'max'", () => {
    expect(sanitizeEffortFor("low", "codex")).toBe("low");
    expect(sanitizeEffortFor("medium", "codex")).toBe("medium");
    expect(sanitizeEffortFor("max", "print")).toBe("max");
  });
});

describe("contextWindowFor is engine-aware", () => {
  test("codex 'default' is the codex window, not claude's 1M", () => {
    expect(contextWindowFor("default", "print")).toBe(1_000_000);
    expect(contextWindowFor("default", "codex")).toBe(400_000);
  });
});

describe("workspace helpers (BRO-1627)", () => {
  test("workspaceToBody: '' → undefined (omit → server default); an id passes through", () => {
    expect(workspaceToBody("")).toBeUndefined();
    expect(workspaceToBody("ws-alpha")).toBe("ws-alpha");
  });

  test("workspaceShowsPicker: only with a real choice (>1)", () => {
    expect(workspaceShowsPicker(0)).toBe(false);
    expect(workspaceShowsPicker(1)).toBe(false);
    expect(workspaceShowsPicker(2)).toBe(true);
  });
});
