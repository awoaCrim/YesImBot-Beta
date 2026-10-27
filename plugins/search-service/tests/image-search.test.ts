import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { createSearXNGBackend } from "../src/backends/searxng.js";
import { createTavilyBackend } from "../src/backends/tavily.js";

const runtime = { defaultLimit: 5, maxLimit: 10, timeoutMs: 1000, blacklist: ["blocked\\.example"] };
const context = { toolCallId: "search", turnId: "turn-1", messages: [] } as never;
const logger = { error: vi.fn() };

describe("public reference image search", () => {
  it("requests Tavily images with descriptions, keeps real attribution, and bounds candidates", async () => {
    const post = vi.fn(async () => ({
      images: [{ url: "https://cdn.example/a.png", description: "duplicate without attribution" }, "https://cdn.example/b.png", null],
      results: [
        { url: "https://source.example/character", title: "Official character", images: [{ url: "https://cdn.example/a.png", description: "x".repeat(1000) }] },
        { url: "https://blocked.example/page", images: [{ url: "https://cdn.example/blocked.png" }] },
      ],
    }));
    const backend = createTavilyBackend(
      { http: { post } } as never,
      { apiKey: "secret", searchEndpoint: "https://search.example", extractEndpoint: "https://extract.example" },
      runtime,
      logger as never,
    );
    const tool = backend.createImageSearchTool();
    const output = await tool.execute({ query: "public character", limit: 2 }, context);
    expect(post).toHaveBeenCalledWith(
      "https://search.example",
      { query: "public character", search_depth: "basic", max_results: 2, include_images: true, include_image_descriptions: true },
      expect.objectContaining({ timeout: 1000 }),
    );
    expect(output).toMatchObject({
      provider: "tavily",
      results: [
        { imageUrl: "https://cdn.example/a.png", sourcePageUrl: "https://source.example/character", title: "Official character" },
        { imageUrl: "https://cdn.example/b.png" },
      ],
    });
    const results = (output as { results: Array<{ description?: string; sourcePageUrl?: string }> }).results;
    expect(results[0]?.description?.length).toBeLessThanOrEqual(301);
    expect(results[1]?.sourcePageUrl).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain("secret");
  });

  it("requests SearXNG image results without inheriting web-only engines and never substitutes thumbnails", async () => {
    const get = vi.fn(async () => ({
      results: [
        {
          url: "https://source.example/item",
          img_src: "https://cdn.example/original.webp",
          thumbnail_src: "https://cdn.example/thumb.webp",
          title: "Product",
          content: "A product",
        },
        { url: "https://source.example/thumb-only", thumbnail_src: "https://cdn.example/only-thumb.webp" },
        { url: "https://source.example/item", img_src: "file:///etc/passwd" },
        { url: "https://source.example/item", img_src: "https://user:secret@cdn.example/a.png" },
        { url: "https://blocked.example/page", img_src: "https://cdn.example/blocked.png" },
      ],
    }));
    const backend = createSearXNGBackend(
      { http: { get } } as never,
      { endpoint: "https://search.example", engines: ["web-only"], categories: ["general"], language: "en", safeSearch: 1 },
      runtime,
      logger as never,
    );
    const output = await backend.createImageSearchTool().execute({ query: "Product model" }, context);
    expect(get).toHaveBeenCalledWith("https://search.example/search", {
      params: { q: "Product model", format: "json", categories: "images", language: "en", safesearch: "1" },
      headers: {},
      timeout: 1000,
    });
    expect(output).toEqual({
      provider: "searxng",
      query: "Product model",
      results: [{ imageUrl: "https://cdn.example/original.webp", sourcePageUrl: "https://source.example/item", title: "Product", description: "A product" }],
    });
  });

  it.each(["tavily", "searxng"])("bounds %s failures and never logs upstream secrets", async (provider) => {
    const request = vi.fn(async () => {
      throw new Error("secret raw provider response");
    });
    const log = { error: vi.fn() };
    const backend =
      provider === "tavily"
        ? createTavilyBackend(
            { http: { post: request } } as never,
            { apiKey: "secret", searchEndpoint: "https://search.example", extractEndpoint: "https://extract.example" },
            runtime,
            log as never,
          )
        : createSearXNGBackend({ http: { get: request } } as never, { endpoint: "https://search.example" }, runtime, log as never);
    const tool = backend.createImageSearchTool();
    expect(await tool.execute({ query: "public subject" }, context)).toMatchObject({ results: [], error: { code: "request_failed" } });
    expect(JSON.stringify(log.error.mock.calls)).not.toMatch(/secret|raw provider/);
    await expect(tool.execute({ query: " " }, context)).resolves.toMatchObject({ results: [], error: { code: "invalid_query" } });
    expect(request).toHaveBeenCalledOnce();
  });
});
