import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { Config } from "../src/config.js";

describe("Config schema", () => {
  it("keeps video input opt-in and preserves independent image configuration", () => {
    const old = Config({ chatModel: "test:model", imageInput: true } as never) as { videoInput?: boolean; imageInput: boolean };
    expect(old.videoInput).toBe(false);
    expect(old.imageInput).toBe(true);
    const video = Config({ chatModel: "test:model", videoInput: true, imageInput: false } as never) as typeof old;
    expect(video.videoInput).toBe(true);
    expect(video.imageInput).toBe(false);
  });

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
    expect(Object.keys(sessionGroup?.dict ?? {})).toEqual(["compact", "archive", "magicContext"]);
  });

  it("keeps Magic Context disabled for old configurations and accepts compartment opt-in", () => {
    const resolved = Config({ chatModel: "test:model" } as never) as { session: { magicContext: { enabled: boolean } } };
    expect(resolved.session.magicContext.enabled).toBe(false);
    const enabled = Config({
      chatModel: "test:model",
      session: { compact: { mode: "compartment" }, magicContext: { enabled: true, contextWindow: 50_000 } },
    } as never) as { session: { magicContext: { enabled: boolean; contextWindow: number } } };
    expect(enabled.session.magicContext).toMatchObject({ enabled: true, contextWindow: 50_000 });
  });

  it("does not expose an optional switch for the mandatory role workflow", () => {
    const json = Config.toJSON() as { refs: Record<string, { dict?: Record<string, string | number> }> };
    expect(Object.values(json.refs).some((ref) => ref.dict?.preventSelfStyleImitation !== undefined)).toBe(false);
    expect(Config({ chatModel: "test:model" } as never)).not.toHaveProperty("preventSelfStyleImitation");
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

  it("hides deprecated settings and exposes one history model selector under Magic Context", () => {
    type SchemaNode = {
      meta?: { description?: string; hidden?: boolean };
      dict?: Record<string, string | number>;
    };
    const json = Config.toJSON() as { refs: Record<string, SchemaNode> };
    const session = Object.values(json.refs).find((ref) => ref.meta?.description === "会话管理");
    const compact = json.refs[String(session?.dict?.compact)];
    const magic = json.refs[String(session?.dict?.magicContext)];

    for (const field of ["responseIdleMinutes", "checkIntervalMinutes", "turnThreshold", "model"]) {
      expect(json.refs[String(compact?.dict?.[field])]).toMatchObject({ meta: { hidden: true } });
    }
    for (const field of ["historyBudgetPercentage", "recentMessages", "maxLoadedBlocks", "pageTokenBudget", "retainTurns", "mediaReserveTokens"]) {
      expect(json.refs[String(magic?.dict?.[field])]).toMatchObject({ meta: { hidden: true } });
    }
    for (const field of ["minMessages", "maxFailures", "inlineFragments", "mode", "chunkMessages", "chunkChars", "assistantAsFacts"]) {
      expect(compact?.dict).toHaveProperty(field);
      expect(json.refs[String(compact?.dict?.[field])]?.meta?.hidden).not.toBe(true);
    }
    for (const field of ["enabled", "model", "contextWindow", "outputReserveTokens"]) {
      expect(magic?.dict).toHaveProperty(field);
      expect(json.refs[String(magic?.dict?.[field])]?.meta?.hidden).not.toBe(true);
    }
    expect(compact?.meta?.description).toBe("兼容历史压缩");
    expect(json.refs[String(magic?.dict?.model)]?.meta?.description).toContain("历史整理模型");
  });

  it("preserves hidden legacy values alongside the new history model without enabling Magic or rewriting the old model", () => {
    const compact = { responseIdleMinutes: 120, checkIntervalMinutes: 60, turnThreshold: 80, model: "test:legacy" };
    const compatibility = {
      historyBudgetPercentage: 30,
      recentMessages: 40,
      maxLoadedBlocks: 2,
      pageTokenBudget: 512,
      retainTurns: 1,
      mediaReserveTokens: 256,
    };
    const resolved = Config({
      chatModel: "test:main",
      session: { compact, magicContext: { ...compatibility, model: "test:history" } },
    } as never) as { session: { compact: typeof compact; magicContext: typeof compatibility & { enabled: boolean; model: string } } };

    expect(resolved.session.compact).toMatchObject(compact);
    expect(resolved.session.magicContext).toMatchObject({ ...compatibility, enabled: false, model: "test:history" });
  });

  it("keeps history model selection optional and preserves old-only configuration", () => {
    const defaults = Config({ chatModel: "test:main" } as never) as { session: { compact: { model?: string }; magicContext: { model?: string } } };
    const legacy = Config({ chatModel: "test:main", session: { compact: { model: "test:legacy" } } } as never) as typeof defaults;
    expect(defaults.session.magicContext.model).toBeUndefined();
    expect(defaults.session.compact.model).toBeUndefined();
    expect(legacy.session.magicContext.model).toBeUndefined();
    expect(legacy.session.compact.model).toBe("test:legacy");
  });

  it.each([
    ["historyBudgetPercentage", 0],
    ["recentMessages", 0],
    ["maxLoadedBlocks", 5],
    ["pageTokenBudget", 127],
    ["retainTurns", 3],
    ["mediaReserveTokens", 0],
  ])("still validates hidden Magic compatibility field %s", (field, value) => {
    expect(() => Config({ chatModel: "test:main", session: { magicContext: { [field]: value } } } as never)).toThrow();
  });
});
