import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { resolveOpenAIThinkingOptions } from "../src/index.js";

describe("OpenAI thinking settings", () => {
  it("keeps the provider default path when no level is configured", () => {
    expect(resolveOpenAIThinkingOptions({ id: "gpt-5" })).toBeUndefined();
  });

  it("maps off to the Chat and Responses native none effort", () => {
    expect(resolveOpenAIThinkingOptions({ id: "gpt-5", reasoning: true, thinkingLevel: "off" })).toEqual({
      clamped: false,
      level: "off",
      providerOptions: { reasoningEffort: "none" },
      requested: "off",
    });
  });

  it("uses a model-specific native override for xhigh", () => {
    expect(
      resolveOpenAIThinkingOptions({
        id: "gpt-5",
        reasoning: true,
        thinkingLevel: "xhigh",
        thinkingLevelMap: { xhigh: "max" },
      }),
    ).toEqual({
      clamped: false,
      level: "xhigh",
      providerOptions: { reasoningEffort: "max" },
      requested: "xhigh",
    });
  });

  it("clamps a model-declared unsupported level to the nearest available level", () => {
    expect(resolveOpenAIThinkingOptions({ id: "gpt-5", reasoning: true, thinkingLevel: "max", thinkingLevelMap: { max: null } })).toEqual({
      clamped: true,
      level: "high",
      providerOptions: { reasoningEffort: "high" },
      requested: "max",
    });
  });

  it("maps a non-reasoning model to none", () => {
    expect(resolveOpenAIThinkingOptions({ id: "gpt-4o", reasoning: false, thinkingLevel: "high" })).toEqual({
      clamped: true,
      level: "off",
      providerOptions: { reasoningEffort: "none" },
      requested: "high",
    });
  });
});
