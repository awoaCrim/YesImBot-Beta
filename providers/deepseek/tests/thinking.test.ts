import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { resolveDeepSeekThinking } from "../src/index.js";

describe("DeepSeek thinking settings", () => {
  it("keeps the legacy global default when no model level is configured", () => {
    expect(resolveDeepSeekThinking("deepseek-v4-pro", { id: "deepseek-v4-pro" }, "auto")).toEqual({
      actualId: "deepseek-v4-pro",
      clamped: false,
      level: undefined,
      options: { thinking: { type: "adaptive" } },
      requested: undefined,
    });
  });

  it("uses the explicit model level before the legacy global default", () => {
    expect(resolveDeepSeekThinking("deepseek-v4-pro", { id: "deepseek-v4-pro", reasoning: true, thinkingLevel: "high" }, "low")).toEqual({
      actualId: "deepseek-v4-pro",
      clamped: false,
      level: "high",
      options: { thinking: { type: "enabled" }, reasoningEffort: "high" },
      requested: "high",
    });
  });

  it("disables thinking for off", () => {
    expect(resolveDeepSeekThinking("deepseek-v4-pro", { id: "deepseek-v4-pro", reasoning: true, thinkingLevel: "off" }, "high")).toEqual({
      actualId: "deepseek-v4-pro",
      clamped: false,
      level: "off",
      options: { thinking: { type: "disabled" } },
      requested: "off",
    });
  });

  it("clamps a model-declared unsupported level", () => {
    expect(
      resolveDeepSeekThinking("deepseek-v4-pro", { id: "deepseek-v4-pro", reasoning: true, thinkingLevel: "max", thinkingLevelMap: { max: null } }, "high"),
    ).toEqual({
      actualId: "deepseek-v4-pro",
      clamped: true,
      level: "high",
      options: { thinking: { type: "enabled" }, reasoningEffort: "high" },
      requested: "max",
    });
  });

  it("keeps the legacy suffix as the most specific override", () => {
    expect(resolveDeepSeekThinking("deepseek-v4-pro:high", { id: "deepseek-v4-pro:high", reasoning: true, thinkingLevel: "off" }, "none")).toEqual({
      actualId: "deepseek-v4-pro",
      clamped: false,
      level: undefined,
      options: { thinking: { type: "enabled" }, reasoningEffort: "high" },
      requested: undefined,
    });
  });
});
