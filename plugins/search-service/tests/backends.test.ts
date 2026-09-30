import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { createSearXNGBackend } from "../src/backends/searxng.js";
import { createTavilyBackend } from "../src/backends/tavily.js";
import SearchService from "../src/index.js";

const runtime = { defaultLimit: 5, maxLimit: 10, timeoutMs: 1_000, blacklist: [] };
const logger = { error: vi.fn() };

async function snapshotFor(provider: "tavily" | "searxng"): Promise<{ prompt: string; tools: Array<{ name: string; description?: string }> }> {
  const serviceLogger = { error: vi.fn(), info: vi.fn() };
  const ctx = { logger: vi.fn(() => serviceLogger), on: vi.fn(), yesimbot: { agent: { use: vi.fn(() => () => undefined) } } };
  const config =
    provider === "tavily"
      ? { provider, tavily: { apiKey: "test", searchEndpoint: "https://example.com/search", extractEndpoint: "https://example.com/extract" } }
      : { provider, searxng: { endpoint: "https://example.com" } };
  const service = new SearchService(ctx as never, config as never);

  await service.start();
  try {
    const plugin = service.setup({} as never, {} as never);
    if (!plugin || typeof plugin.appendSystemPrompt !== "function") throw new Error("search plugin was not initialized");
    const tools = Array.isArray(plugin.tools) ? plugin.tools : [];
    return {
      prompt: plugin.appendSystemPrompt(),
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
    };
  } finally {
    await service.stop();
  }
}

describe("search backend tool names", () => {
  it("names Tavily search tavily_web_search", () => {
    const backend = createTavilyBackend(
      {} as never,
      { apiKey: "test", searchEndpoint: "https://example.com/search", extractEndpoint: "https://example.com/extract" },
      runtime,
      logger as never,
    );

    expect(backend.createSearchTool().name).toBe("tavily_web_search");
  });

  it("names Tavily scraper tavily_web_scrape", () => {
    const backend = createTavilyBackend(
      {} as never,
      { apiKey: "test", searchEndpoint: "https://example.com/search", extractEndpoint: "https://example.com/extract" },
      runtime,
      logger as never,
    );

    expect(backend.createScrapeTool?.().name).toBe("tavily_web_scrape");
  });

  it("names SearXNG search searxng_web_search", () => {
    const backend = createSearXNGBackend({} as never, { endpoint: "https://example.com" }, runtime, logger as never);

    expect(backend.createSearchTool().name).toBe("searxng_web_search");
  });

  it("keeps provider-specific names in tools instead of the shared system prompt", async () => {
    const tavily = await snapshotFor("tavily");
    expect(tavily.prompt).not.toContain("tavily_web_search");
    expect(tavily.prompt).not.toContain("tavily_web_scrape");
    expect(tavily.prompt).toContain("当前提供的 web search 工具");
    expect(tavily.tools.map((tool) => tool.name)).toEqual(["tavily_web_search", "tavily_web_scrape"]);
    expect(tavily.tools.map((tool) => tool.description).join("\n")).toContain("tavily_web_search");

    const searxng = await snapshotFor("searxng");
    expect(searxng.prompt).not.toContain("searxng_web_search");
    expect(searxng.prompt).toContain("当前提供的 web search 工具");
    expect(searxng.tools.map((tool) => tool.name)).toEqual(["searxng_web_search"]);
  });
});
