import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { Config } from "../src/config.js";

describe("Config schema", () => {
  it("keeps session management fields under the 会话管理 group", () => {
    const json = Config.toJSON() as {
      refs: Record<
        string,
        {
          type?: string;
          meta?: { description?: string };
          dict?: Record<string, string | number>;
        }
      >;
    };
    const sessionGroup = Object.values(json.refs).find((ref) => ref.meta?.description === "会话管理");

    expect(sessionGroup).toBeDefined();
    expect(sessionGroup?.type).toBe("object");
    expect(Object.keys(sessionGroup?.dict ?? {})).toEqual(["compact", "archive"]);
  });

  it("defaults custom inner thought to disabled", () => {
    const resolved = Config({ chatModel: "test:model" } as never) as { customInnerThought?: boolean };
    expect(resolved.customInnerThought).toBe(false);
  });

  it("defaults main-channel model retries to three and bounds them to zero through five", () => {
    type SchemaNode = {
      type?: string;
      meta?: { description?: string; default?: unknown; min?: number; max?: number };
      dict?: Record<string, string | number>;
    };
    const json = Config.toJSON() as { refs: Record<string, SchemaNode> };
    const inputGroup = Object.values(json.refs).find((ref) => ref.meta?.description === "模型输入与资源读取");
    const modelRetries = json.refs[String(inputGroup?.dict?.modelRetries)];

    expect(modelRetries).toMatchObject({ type: "number", meta: { default: 3, min: 0, max: 5 } });
    expect((Config({ chatModel: "test:model" } as never) as { modelRetries?: number }).modelRetries).toBe(3);
  });

  it("accepts deprecated periodic and turn-limit settings as inert compatibility fields", () => {
    const resolved = Config({ chatModel: "test:model" } as never) as {
      session: {
        compact: {
          responseIdleMinutes: number;
          checkIntervalMinutes: number;
          turnThreshold: number;
          minMessages: number;
          maxFailures: number;
          inlineFragments: number;
          mode: "summary" | "compartment";
          chunkMessages: number;
          chunkChars: number;
          assistantAsFacts: boolean;
        };
      };
    };

    expect(resolved.session.compact).toMatchObject({
      responseIdleMinutes: 0,
      checkIntervalMinutes: 30,
      turnThreshold: 50,
      minMessages: 15,
      maxFailures: 3,
      inlineFragments: 3,
      mode: "summary",
      chunkMessages: 20,
      chunkChars: 12_000,
      assistantAsFacts: false,
    });
  });

  it("defaults the resident compact-fragment limit to three and accepts an override", () => {
    const defaulted = Config({ chatModel: "test:model" } as never) as { session: { compact: { inlineFragments: number } } };
    const overridden = Config({ chatModel: "test:model", session: { compact: { inlineFragments: 5 } } } as never) as {
      session: { compact: { inlineFragments: number } };
    };

    expect(defaulted.session.compact.inlineFragments).toBe(3);
    expect(overridden.session.compact.inlineFragments).toBe(5);
  });

  it.each([
    ["resident fragments zero", "inlineFragments", 0],
    ["resident fragments fractional", "inlineFragments", 1.5],
    ["resident fragments infinity", "inlineFragments", Number.POSITIVE_INFINITY],
    ["check interval", "checkIntervalMinutes", 0],
    ["check interval infinity", "checkIntervalMinutes", Number.POSITIVE_INFINITY],
    ["check interval overflow", "checkIntervalMinutes", Number.MAX_VALUE],
    ["turn threshold", "turnThreshold", 0],
    ["turn threshold fractional", "turnThreshold", 1.5],
    ["turn threshold infinity", "turnThreshold", Number.POSITIVE_INFINITY],
    ["message threshold", "minMessages", 0],
    ["message threshold NaN", "minMessages", Number.NaN],
  ])("rejects invalid %s", (_label, field, value) => {
    expect(() => Config({ chatModel: "test:model", session: { compact: { [field]: value } } } as never)).toThrow();
  });
});
