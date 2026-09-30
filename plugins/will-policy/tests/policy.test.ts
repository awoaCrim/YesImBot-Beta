import { describe, expect, it } from "vitest";

import { resolvePolicy } from "../src/policy.js";
import { defaultRoutingConfig, defaultWillingnessConfig } from "../src/types.js";

describe("resolvePolicy", () => {
  it("resolves the configured engine and complete defaults", () => {
    const config = {
      engine: "willingness",
      routing: defaultRoutingConfig(),
      willingness: { ...defaultWillingnessConfig(), probabilityThreshold: 30, textGain: 20 },
    };

    const resolved = resolvePolicy(config);

    expect(resolved.engine).toBe("willingness");
    expect(resolved.willingness.probabilityThreshold).toBe(30);
    expect(resolved.willingness.textGain).toBe(20);
    expect(resolved.willingness).toMatchObject({ batchDecision: "per-input", decayMode: "weighted", persistState: false });
    expect(resolved.routing.group).toBe("wait");
  });

  it("does not mutate the cloned base config", () => {
    const config = { engine: "routing", routing: defaultRoutingConfig(), willingness: defaultWillingnessConfig() };
    const resolved = resolvePolicy(config);

    expect(resolved.routing).not.toBe(config.routing);
    expect(resolved.willingness).not.toBe(config.willingness);
  });

  it("keeps routing as a rollback switch even when an inert willingness block is invalid", () => {
    expect(() =>
      resolvePolicy({
        engine: "routing",
        routing: defaultRoutingConfig(),
        willingness: { ...defaultWillingnessConfig(), maxScore: 0 },
      }),
    ).not.toThrow();
  });

  it.each([
    ["non-positive maxScore", { maxScore: 0 }],
    ["threshold over maxScore", { probabilityThreshold: 101 }],
    ["negative replyCost", { replyCost: -1 }],
    ["invalid half-life", { decayHalfLifeSeconds: Number.NaN }],
    ["reversed weighted windows", { hotWindowSeconds: 61, warmWindowSeconds: 60 }],
    ["empty normalized keyword", { keywords: ["  "] }],
    ["persistence without batch mode", { persistState: true }],
    ["force flag in pure batch mode", { batchDecision: "highest-candidate", mentionForce: true }],
  ])("rejects %s", (_label, overrides) => {
    expect(() =>
      resolvePolicy({
        engine: "willingness",
        willingness: { ...defaultWillingnessConfig(), ...overrides },
      }),
    ).toThrow();
  });
});
