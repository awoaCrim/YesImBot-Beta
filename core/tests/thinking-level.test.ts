import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import type { ThinkingLevelMap } from "../src/models/index.js";
import { createThinkingLevelMapSchema, getSupportedThinkingLevels, resolveThinkingLevel } from "../src/models/index.js";

const GOOGLE_DEFAULTS: ThinkingLevelMap = { minimal: "minimal", low: "low", medium: "medium", high: "high" };
const OPENAI_DEFAULTS: ThinkingLevelMap = { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high" };

describe("getSupportedThinkingLevels", () => {
  it("exposes only off when the model does not support reasoning", () => {
    expect(getSupportedThinkingLevels({ defaultMap: OPENAI_DEFAULTS, reasoning: false })).toEqual(["off"]);
  });

  it("drops levels explicitly marked unsupported by the model", () => {
    expect(getSupportedThinkingLevels({ defaultMap: OPENAI_DEFAULTS, thinkingLevelMap: { high: null, low: null } })).toEqual(["off", "minimal", "medium"]);
  });

  it("keeps xhigh and max unavailable until the model maps them explicitly", () => {
    expect(getSupportedThinkingLevels({ defaultMap: OPENAI_DEFAULTS })).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(getSupportedThinkingLevels({ defaultMap: OPENAI_DEFAULTS, thinkingLevelMap: { xhigh: "xhigh" } })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("treats native values rejected by the provider as unsupported", () => {
    const isNativeValue = (value: string) => value === "low" || value === "high";

    expect(getSupportedThinkingLevels({ defaultMap: GOOGLE_DEFAULTS, isNativeValue, thinkingLevelMap: { medium: "bogus" } })).toEqual([
      "minimal",
      "low",
      "high",
    ]);
  });
});

describe("resolveThinkingLevel", () => {
  it("returns undefined native when no provider default exists for the level", () => {
    const resolved = resolveThinkingLevel({ defaultMap: GOOGLE_DEFAULTS, reasoning: false }, "off");

    expect(resolved).toEqual({ clamped: false, level: "off", native: undefined });
  });

  it("prefers the nearest higher available level when the request is unavailable", () => {
    expect(resolveThinkingLevel({ defaultMap: GOOGLE_DEFAULTS }, "xhigh")).toEqual({ clamped: true, level: "high", native: "high" });
  });

  it("falls back to the nearest lower level when no higher level is available", () => {
    expect(resolveThinkingLevel({ defaultMap: { low: "low", medium: "medium" } }, "max")).toEqual({
      clamped: true,
      level: "medium",
      native: "medium",
    });
  });

  it("uses the provider default native value when the model map omits the level", () => {
    expect(resolveThinkingLevel({ defaultMap: OPENAI_DEFAULTS }, "off")).toEqual({ clamped: false, level: "off", native: "none" });
  });

  it("uses the model override instead of the provider default", () => {
    expect(resolveThinkingLevel({ defaultMap: GOOGLE_DEFAULTS, thinkingLevelMap: { medium: "high" } }, "medium")).toEqual({
      clamped: false,
      level: "medium",
      native: "high",
    });
  });

  it("clamps a requested level when the model marks it unsupported", () => {
    expect(resolveThinkingLevel({ defaultMap: OPENAI_DEFAULTS, thinkingLevelMap: { off: null } }, "off")).toEqual({
      clamped: true,
      level: "minimal",
      native: "minimal",
    });
  });

  it("keeps off as the only level for models without reasoning support", () => {
    expect(resolveThinkingLevel({ defaultMap: OPENAI_DEFAULTS, reasoning: false }, "high")).toEqual({
      clamped: true,
      level: "off",
      native: "none",
    });
  });

  it("maps an unsupported request onto the model override for the nearest level", () => {
    expect(resolveThinkingLevel({ defaultMap: GOOGLE_DEFAULTS, thinkingLevelMap: { xhigh: "high" } }, "xhigh")).toEqual({
      clamped: false,
      level: "xhigh",
      native: "high",
    });
  });
});

describe("createThinkingLevelMapSchema", () => {
  const schema = createThinkingLevelMapSchema(["low", "high"]);

  it("accepts configured native values and explicit unsupported markers", () => {
    expect(schema({ low: "low", off: null })).toEqual({ low: "low", off: null });
  });

  it("rejects native values outside the provider contract", () => {
    expect(() => schema({ low: "medium" })).toThrow();
  });
});
