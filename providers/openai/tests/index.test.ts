import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("koishi", async () => import("@koishijs/core"));

import { resolveReadImagePolicy } from "../../../core/src/runtimes/index.js";
import { Config, apply } from "../src/index.js";

type RegisteredProvider = {
  chatCapabilities?(modelId: string): { readonly imageToolResult?: "native" | "unsupported" | "unknown" };
  tools?(modelId: string): Record<string, { readonly id?: string; readonly type?: string }>;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function registerProvider(config: Record<string, unknown>): RegisteredProvider {
  let ready: (() => void) | undefined;
  const model = { register: vi.fn(() => () => undefined) };
  const ctx = {
    on(event: string, callback: () => void) {
      if (event === "ready") ready = callback;
    },
    yesimbot: { model },
  };

  apply(ctx as never, config as never);
  if (!ready) throw new Error("provider did not register a ready callback");
  ready();
  return model.register.mock.calls[0]?.[0] as RegisteredProvider;
}

describe("OpenAI image tool-result capability", () => {
  it.each([
    ["chat", "unsupported"],
    ["responses", "native"],
  ] as const)("defaults %s format to %s when no override is configured", (format, imageToolResult) => {
    const provider = registerProvider({ id: "openai", apiKey: "test", format, chatModels: [], embeddingModels: [] });

    expect(provider.chatCapabilities?.("gpt-5")).toEqual({ imageToolResult });
  });

  it.each(["unsupported", "unknown"] as const)("propagates an explicit %s override and routes to vision fallback", (imageToolResultSupport) => {
    const provider = registerProvider({
      id: "antigravity",
      apiKey: "test",
      format: "responses",
      imageToolResultSupport,
      imageToolResultPlacement: "user-message",
      chatModels: [],
      embeddingModels: [],
    });
    const capabilities = provider.chatCapabilities?.("gpt-5");
    if (!capabilities) throw new Error("provider did not declare chat capabilities");

    expect(capabilities).toEqual({ imageToolResult: imageToolResultSupport });
    expect(
      resolveReadImagePolicy(
        {
          entry: { modalities: { input: ["image"] } },
          capabilities,
          model: { id: "primary" },
        } as never,
        { entry: { modalities: { input: ["image"] } }, model: { id: "vision" } } as never,
        true,
      ),
    ).toMatchObject({ mode: "vision", visionModel: { id: "vision" } });
  });

  it("exposes the optional imageToolResultSupport override with all supported values", () => {
    type SchemaNode = {
      type?: string;
      list?: number[];
      dict?: Record<string, number>;
      value?: string;
      meta?: { default?: unknown; description?: string };
    };
    const json = Config.toJSON() as { uid: number; refs: Record<string, SchemaNode> };
    const root = json.refs[String(json.uid)];
    const base = json.refs[String(root?.list?.[0])];
    const support = json.refs[String(base?.dict?.imageToolResultSupport)];
    const values = support?.list?.map((id) => json.refs[String(id)]?.value);

    expect(base?.dict).toHaveProperty("imageToolResultSupport");
    expect(base?.dict).toHaveProperty("imageToolResultPlacement");
    expect(support).toMatchObject({
      type: "union",
      meta: { description: "图片工具结果能力覆盖；留空时按 API 格式推导" },
    });
    expect(support?.meta?.default).toBeUndefined();
    expect(values).toEqual(["native", "unsupported", "unknown"]);

    const placement = json.refs[String(base?.dict?.imageToolResultPlacement)];
    const placementValues = placement?.list?.map((id) => json.refs[String(id)]?.value);
    expect(placement).toMatchObject({
      type: "union",
      meta: { default: "tool-output", description: "原生图片工具结果的请求位置" },
    });
    expect(placementValues).toEqual(["tool-output", "user-message"]);
  });

  it("keeps native capability when user-message placement is enabled", () => {
    const provider = registerProvider({
      id: "antigravity",
      apiKey: "test",
      format: "responses",
      imageToolResultSupport: "native",
      imageToolResultPlacement: "user-message",
      chatModels: [],
      embeddingModels: [],
    });

    expect(provider.chatCapabilities?.("gpt-5")).toEqual({ imageToolResult: "native" });
  });

  it("does not expose image-generation configuration", () => {
    const json = Config.toJSON() as { uid: number; refs: Record<string, { list?: number[]; dict?: Record<string, number> }> };
    const root = json.refs[String(json.uid)];
    const base = json.refs[String(root?.list?.[0])];
    expect(base?.dict).not.toHaveProperty("imageGeneration");
  });
});

describe("OpenAI native web search", () => {
  it("registers web_search for opted-in Responses models", () => {
    const provider = registerProvider({ id: "openai", apiKey: "test", format: "responses", webSearch: true, chatModels: [], embeddingModels: [] });

    expect(provider.tools?.("gpt-5")?.web_search).toMatchObject({ type: "provider", id: "openai.web_search" });
  });

  it("omits web_search when Responses search is not enabled", () => {
    const provider = registerProvider({ id: "openai", apiKey: "test", format: "responses", webSearch: false, chatModels: [], embeddingModels: [] });

    expect(provider.tools?.("gpt-5")).toEqual({});
  });

  it("omits web_search for the Chat Completions format", () => {
    const provider = registerProvider({ id: "openai", apiKey: "test", format: "chat", webSearch: true, chatModels: [], embeddingModels: [] });

    expect(provider.tools?.("gpt-5")).toEqual({});
  });
});
