import { AgentTool, jsonSchema } from "@yesimbot/agent-runtime";
import type { Context, Logger } from "koishi";
import { Schema } from "koishi";

import type { ImageSearchOutput, SearchBackend, SearchRuntimeConfig, WebScrapeOutput, WebSearchOutput } from "../types";
import { clampLimit, compileBlacklist, dedupeByUrl, filterBlockedResults, MAX_IMAGE_CANDIDATES, normalizeImageCandidates, normalizeUrlList } from "../utils";

export const tavilyConfigSchema: Schema<TavilyConfig> = Schema.intersect([
  Schema.object({
    apiKey: Schema.string().required().description("Tavily 搜索与网页提取共用的 API Key。"),
    searchEndpoint: Schema.string().default("https://api.tavily.com/search").description("网页搜索与图片搜索共用的完整请求地址。"),
    extractEndpoint: Schema.string().default("https://api.tavily.com/extract").description("网页正文提取的完整请求地址；不用于参考图片下载。"),
  }).description("Tavily 连接"),
  Schema.object({
    searchDepth: Schema.union([Schema.const("basic"), Schema.const("advanced")])
      .default("basic")
      .description("网页与图片搜索的默认深度；网页搜索可在单次调用中覆盖。"),
    topic: Schema.union([Schema.const("general"), Schema.const("news"), Schema.const("finance")]).description(
      "仅网页搜索的默认主题；单次调用可覆盖，不影响图片搜索。",
    ),
    timeRange: Schema.union([Schema.const("day"), Schema.const("week"), Schema.const("month"), Schema.const("year")]).description(
      "仅网页搜索的默认时间范围；单次调用可覆盖，不影响图片搜索。",
    ),
  }).description("搜索默认行为"),
]);

const MAX_URLS_PER_SCRAPE = 20;

const searchInputSchema = jsonSchema<TavilySearchInput>({
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, description: "Search query." },
    limit: { type: "number", minimum: 1, description: "Maximum number of results." },
    searchDepth: { type: "string", enum: ["basic", "advanced"], description: "Search depth." },
    topic: { type: "string", enum: ["general", "news", "finance"], description: "Search topic." },
    timeRange: { type: "string", enum: ["day", "week", "month", "year"], description: "Time range." },
    startDate: { type: "string", description: "Start date for the search." },
    endDate: { type: "string", description: "End date for the search." },
    includeRawContent: { type: "string", enum: ["none", "text", "markdown"], description: "Include raw content in the results." },
  },
  required: ["query"],
});

const scrapeInputSchema = jsonSchema<TavilyScrapeInput>({
  type: "object",
  properties: { urls: { type: "array", items: { type: "string", format: "uri" }, minItems: 1, description: "HTTP or HTTPS URLs to extract." } },
  required: ["urls"],
});

const imageSearchInputSchema = jsonSchema<TavilyImageSearchInput>({
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      pattern: "\\S",
      description: "Image search query naming the public subject, character, or product.",
    },
    limit: { type: "integer", minimum: 1, maximum: MAX_IMAGE_CANDIDATES, description: "Maximum number of image candidates." },
  },
  required: ["query"],
});

type TavilySearchDepth = "basic" | "advanced";

type TavilyTopic = "general" | "news" | "finance";

type TavilyTimeRange = "day" | "week" | "month" | "year";

type TavilyRawContent = "none" | "text" | "markdown";

export interface TavilyConfig {
  apiKey: string;
  searchEndpoint: string;
  extractEndpoint: string;
  searchDepth?: TavilySearchDepth;
  topic?: TavilyTopic;
  timeRange?: TavilyTimeRange;
}

interface TavilyRuntimeConfig extends SearchRuntimeConfig {
  apiKey: string;
  searchEndpoint: string;
  extractEndpoint: string;
  searchDepth: TavilySearchDepth;
  topic?: TavilyTopic;
  timeRange?: TavilyTimeRange;
}

interface TavilySearchInput {
  query: string;
  limit?: number;
  searchDepth?: TavilySearchDepth;
  topic?: TavilyTopic;
  timeRange?: TavilyTimeRange;
  startDate?: string;
  endDate?: string;
  includeRawContent?: TavilyRawContent;
}

interface TavilyScrapeInput {
  urls: string[];
}

interface TavilyImageSearchInput {
  query: string;
  limit?: number;
}

interface TavilyImageEntry {
  url?: string | null;
  description?: string | null;
}

interface TavilySearchResult {
  url: string;
  title: string;
  content: string;
  score?: number;
  raw_content?: string | null;
  favicon?: string | null;
  published_date?: string | null;
  images?: Array<TavilyImageEntry | string> | null;
}

interface TavilySearchResponse {
  results?: TavilySearchResult[];
  images?: Array<TavilyImageEntry | string> | null;
}

interface TavilyExtractResult {
  url: string;
  raw_content?: string | null;
}

interface TavilyExtractResponse {
  results?: TavilyExtractResult[];
  failed_results?: Array<{ url: string; error: string }>;
}

class TavilyBackend implements SearchBackend {
  public readonly name = "tavily";

  private readonly blacklist: RegExp[];

  constructor(
    private readonly ctx: Context,
    private readonly config: TavilyRuntimeConfig,
    private readonly logger: Logger,
  ) {
    this.blacklist = compileBlacklist(config.blacklist);
  }

  public createSearchTool(): AgentTool<TavilySearchInput, WebSearchOutput> {
    return {
      name: "tavily_web_search",
      description: "Search the web for current information, news, facts, or web content. " + "Returns structured JSON with titles, URLs, and snippets.",

      inputSchema: searchInputSchema,
      execute: async (input) => this.search(input),
    };
  }

  public createImageSearchTool(): AgentTool<TavilyImageSearchInput, ImageSearchOutput> {
    return {
      name: "tavily_image_search",
      description: [
        "Find publicly hosted image candidates for an identifiable person, character, product, or object.",
        "Results are candidate clues (image URL, optional source page, title/description), never identity proof.",
        "Inspect the actual pixels with import_image_reference before using one as a generation reference.",
      ].join(" "),
      inputSchema: imageSearchInputSchema,
      execute: async (input) => this.imageSearch(input),
    };
  }

  public createScrapeTool(): AgentTool<TavilyScrapeInput, WebScrapeOutput> {
    return {
      name: "tavily_web_scrape",
      description: "Extract readable content from one or more web pages. " + "Use after tavily_web_search when full page text is needed.",
      inputSchema: scrapeInputSchema,
      execute: async (input) => {
        const normalized = normalizeUrlList(input.urls, MAX_URLS_PER_SCRAPE);
        const validUrls: string[] = [];
        const results: WebScrapeOutput["results"] = [];

        for (const entry of normalized) {
          if ("error" in entry) {
            results.push({ url: entry.url, error: entry.error });
          } else {
            validUrls.push(entry.url);
          }
        }

        if (validUrls.length > 0) {
          const output = await this.scrape(validUrls);
          results.push(...output.results);
        }

        return { provider: this.name, results };
      },
    };
  }

  private async search(input: TavilySearchInput): Promise<WebSearchOutput> {
    const limit = clampLimit(input.limit, this.config.defaultLimit, this.config.maxLimit);
    const body = {
      query: input.query,
      search_depth: input.searchDepth ?? this.config.searchDepth,
      topic: input.topic ?? this.config.topic,
      max_results: limit,
      time_range: input.timeRange ?? this.config.timeRange,
      start_date: input.startDate,
      end_date: input.endDate,
      include_raw_content: input.includeRawContent,
    };

    try {
      const response = await this.ctx.http.post<TavilySearchResponse>(this.config.searchEndpoint, body, {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` },
        timeout: this.config.timeoutMs,
      });

      const rawResults = Array.isArray(response.results) ? response.results : [];
      const mapped = rawResults.map((result) => ({ title: result.title ?? "", url: result.url ?? "", snippet: result.content ?? "", score: result.score }));
      const filtered = filterBlockedResults(mapped, this.blacklist);
      const deduped = dedupeByUrl(filtered);

      return { provider: this.name, query: input.query, results: deduped };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[TavilyBackend] Search failed: ${message}`);
      return { provider: this.name, query: input.query, results: [], error: { message, code: "request_failed" } };
    }
  }

  private async imageSearch(input: TavilyImageSearchInput): Promise<ImageSearchOutput> {
    if (!input.query.trim() || input.query.length > 512)
      return { provider: this.name, query: "", results: [], error: { code: "invalid_query", message: "Provide a public-subject query of 1-512 characters." } };
    const limit = Math.min(clampLimit(input.limit, this.config.defaultLimit, this.config.maxLimit), MAX_IMAGE_CANDIDATES);
    const body = {
      query: input.query,
      search_depth: this.config.searchDepth,
      max_results: limit,
      include_images: true,
      include_image_descriptions: true,
    };

    try {
      const response = await this.ctx.http.post<TavilySearchResponse>(this.config.searchEndpoint, body, {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` },
        timeout: this.config.timeoutMs,
      });

      const rawResults = Array.isArray(response.results) ? response.results : [];
      const topLevel = Array.isArray(response.images) ? response.images : [];
      const candidates = normalizeImageCandidates(
        [
          ...rawResults
            .slice(0, 16)
            .flatMap((result) =>
              Array.isArray(result.images)
                ? result.images.slice(0, 16).map((image) => ({ ...toImageCandidate(image), sourcePageUrl: result.url, title: result.title }))
                : [],
            ),
          ...topLevel.slice(0, 32).map(toImageCandidate),
        ],
        { blacklist: this.blacklist, limit },
      );

      return { provider: this.name, query: input.query, results: candidates };
    } catch {
      const message = "Image search failed. Retry later or ask the user for a reference image.";
      this.logger.error("[TavilyBackend] Image search failed");
      return { provider: this.name, query: input.query, results: [], error: { message, code: "request_failed" } };
    }
  }

  private async scrape(urls: string[]): Promise<WebScrapeOutput> {
    try {
      const response = await this.ctx.http.post<TavilyExtractResponse>(
        this.config.extractEndpoint,
        { urls },
        { headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` }, timeout: this.config.timeoutMs },
      );

      const results: WebScrapeOutput["results"] = [];

      if (Array.isArray(response.results)) {
        for (const result of response.results) {
          results.push({ url: result.url, content: result.raw_content ?? undefined });
        }
      }

      if (Array.isArray(response.failed_results)) {
        for (const result of response.failed_results) {
          results.push({ url: result.url, error: result.error });
        }
      }

      return { provider: this.name, results };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[TavilyBackend] Extract failed: ${message}`);
      return { provider: this.name, results: urls.map((url) => ({ url, error: message })) };
    }
  }
}

export function createTavilyBackend(ctx: Context, config: TavilyConfig | undefined, runtime: SearchRuntimeConfig, logger: Logger): SearchBackend {
  if (!config?.apiKey) {
    throw new Error("Tavily provider requires tavily.apiKey to be configured");
  }

  return new TavilyBackend(
    ctx,
    {
      ...runtime,
      apiKey: config.apiKey,
      searchEndpoint: config.searchEndpoint,
      extractEndpoint: config.extractEndpoint,
      searchDepth: config.searchDepth ?? "basic",
      topic: config.topic,
      timeRange: config.timeRange,
    },
    logger,
  );
}

function toImageCandidate(value: unknown) {
  if (typeof value === "string") return { imageUrl: value };
  if (!value || typeof value !== "object") return { imageUrl: undefined };
  return { imageUrl: "url" in value ? value.url : undefined, description: "description" in value ? value.description : undefined };
}
