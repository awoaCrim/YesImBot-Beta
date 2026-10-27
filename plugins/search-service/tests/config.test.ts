import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { searxngConfigSchema } from "../src/backends/searxng.js";
import { tavilyConfigSchema } from "../src/backends/tavily.js";
import SearchService from "../src/index.js";

const Config = SearchService.Config;

describe("search-service configuration presentation", () => {
  it("groups operator settings without introducing persisted section keys", () => {
    expect(Config.list?.map((group) => group.meta.description)).toEqual(["搜索后端", "后端配置", "请求与结果限制"]);
    expect(tavilyConfigSchema.type).toBe("intersect");
    expect(tavilyConfigSchema.list?.map((group) => group.meta.description)).toEqual(["Tavily 连接", "搜索默认行为"]);
    expect(searxngConfigSchema.list?.map((group) => group.meta.description)).toEqual(["SearXNG 连接", "通用搜索偏好", "仅网页搜索默认值"]);
  });

  it("preserves the existing default provider, endpoints, limits and units", () => {
    expect(Config({ tavily: { apiKey: "test" } })).toEqual({
      provider: "tavily",
      defaultLimit: 5,
      maxLimit: 10,
      timeoutMs: 10_000,
      blacklist: [],
      tavily: { apiKey: "test", searchEndpoint: "https://api.tavily.com/search", extractEndpoint: "https://api.tavily.com/extract", searchDepth: "basic" },
    });
  });

  it("preserves complete Tavily overrides in the existing nested provider object", () => {
    const previous = {
      provider: "tavily" as const,
      defaultLimit: 3,
      maxLimit: 12,
      timeoutMs: 2500,
      blacklist: ["blocked"],
      tavily: {
        apiKey: "test",
        searchEndpoint: "https://search.example",
        extractEndpoint: "https://extract.example",
        searchDepth: "advanced" as const,
        topic: "news" as const,
        timeRange: "week" as const,
      },
    };
    expect(Config(structuredClone(previous))).toEqual(previous);
  });

  it("preserves the SearXNG branch and its existing defaults and explicit preferences", () => {
    expect(Config({ provider: "searxng", searxng: { endpoint: "https://search.example" } })).toEqual({
      provider: "searxng",
      defaultLimit: 5,
      maxLimit: 10,
      timeoutMs: 10_000,
      blacklist: [],
      searxng: { endpoint: "https://search.example", engines: [], categories: [] },
    });
    const previous = {
      provider: "searxng" as const,
      defaultLimit: 2,
      maxLimit: 7,
      timeoutMs: 4000,
      blacklist: ["blocked"],
      searxng: {
        endpoint: "https://search.example",
        engines: ["web-only"],
        categories: ["general"],
        language: "zh-CN",
        safeSearch: 1 as const,
        username: "test",
        password: "placeholder",
      },
    };
    expect(Config(structuredClone(previous))).toEqual(previous);
  });

  it("keeps required provider credentials and endpoint validation unchanged", () => {
    expect(() => Config({ provider: "tavily", tavily: {} } as never)).toThrow();
    expect(() => Config({ provider: "searxng", searxng: {} } as never)).toThrow();
    expect(() => Config({ provider: "unknown" } as never)).toThrow();
  });
});
