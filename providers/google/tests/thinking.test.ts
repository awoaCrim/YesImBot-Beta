import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { resolveGoogleThinkingOptions } from "../src/index.js";

describe("Google thinking settings", () => {
  it("keeps the provider default path when no level is configured", () => {
    expect(resolveGoogleThinkingOptions({ id: "gemini-3.7-flash" })).toBeUndefined();
  });

  it("maps an explicit level to Google thinkingConfig", () => {
    expect(resolveGoogleThinkingOptions({ id: "gemini-3.7-flash", reasoning: true, thinkingLevel: "high" })).toEqual({
      clamped: false,
      level: "high",
      providerOptions: { thinkingConfig: { thinkingLevel: "high" } },
      requested: "high",
    });
  });

  it("uses an explicit native override for a normally unavailable level", () => {
    expect(
      resolveGoogleThinkingOptions({
        id: "gemini-3.7-flash",
        reasoning: true,
        thinkingLevel: "xhigh",
        thinkingLevelMap: { xhigh: "high" },
      }),
    ).toEqual({
      clamped: false,
      level: "xhigh",
      providerOptions: { thinkingConfig: { thinkingLevel: "high" } },
      requested: "xhigh",
    });
  });

  it("clamps an unavailable level instead of sending an invalid native value", () => {
    expect(resolveGoogleThinkingOptions({ id: "gemini-3.7-flash", reasoning: true, thinkingLevel: "max" })).toEqual({
      clamped: true,
      level: "high",
      providerOptions: { thinkingConfig: { thinkingLevel: "high" } },
      requested: "max",
    });
  });

  it("resolves non-reasoning models to off without adding unsupported options", () => {
    expect(resolveGoogleThinkingOptions({ id: "gemini-3.7-flash", reasoning: false, thinkingLevel: "high" })).toEqual({
      clamped: true,
      level: "off",
      providerOptions: undefined,
      requested: "high",
    });
  });
});
