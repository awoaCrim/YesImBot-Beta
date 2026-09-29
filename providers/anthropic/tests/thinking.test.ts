import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { resolveAnthropicThinkingOptions } from "../src/index.js";

describe("Anthropic thinking settings", () => {
  it("keeps the provider default path when no level is configured", () => {
    expect(resolveAnthropicThinkingOptions({ id: "claude-sonnet" })).toBeUndefined();
  });

  it("disables Anthropic thinking for off", () => {
    expect(resolveAnthropicThinkingOptions({ id: "claude-sonnet", reasoning: true, thinkingLevel: "off" })).toEqual({
      clamped: false,
      level: "off",
      providerOptions: { thinking: { type: "disabled" } },
      requested: "off",
    });
  });

  it("clamps minimal to Anthropic's nearest default effort", () => {
    expect(resolveAnthropicThinkingOptions({ id: "claude-sonnet", reasoning: true, thinkingLevel: "minimal" })).toEqual({
      clamped: true,
      level: "low",
      providerOptions: { effort: "low" },
      requested: "minimal",
    });
  });

  it("uses a model-specific native override for xhigh", () => {
    expect(
      resolveAnthropicThinkingOptions({
        id: "claude-opus",
        reasoning: true,
        thinkingLevel: "xhigh",
        thinkingLevelMap: { xhigh: "xhigh" },
      }),
    ).toEqual({
      clamped: false,
      level: "xhigh",
      providerOptions: { effort: "xhigh" },
      requested: "xhigh",
    });
  });

  it("maps a non-reasoning model to disabled thinking", () => {
    expect(resolveAnthropicThinkingOptions({ id: "claude-haiku", reasoning: false, thinkingLevel: "high" })).toEqual({
      clamped: true,
      level: "off",
      providerOptions: { thinking: { type: "disabled" } },
      requested: "high",
    });
  });
});
