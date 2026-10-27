import { AgentTool, jsonSchema } from "@yesimbot/agent-runtime";
import type { Context, Logger } from "koishi";
import { Schema } from "koishi";

import type { ImageSearchOutput, SearchBackend, SearchRuntimeConfig, WebSearchOutput } from "../types.js";
import { clampLimit, compileBlacklist, dedupeByUrl, filterBlockedResults, MAX_IMAGE_CANDIDATES, normalizeImageCandidates } from "../utils.js";
export const searxngConfigSchema: Schema<SearXNGConfig> = Schema.intersect([
  Schema.object({
    endpoint: Schema.string().required().description("SearXNG 实例根地址或 /search 地址；网页与图片搜索共用。"),
    username: Schema.string().description("实例启用 HTTP Basic 认证时使用的用户名；与 password 同时填写。"),
    password: Schema.string().description("实例的 HTTP Basic 密码；只发往搜索实例，不发往参考图片站点。"),
  }).description("SearXNG 连接"),
  Schema.object({
    language: Schema.string().description("网页与图片搜索的默认语言；网页搜索可在单次调用中覆盖。"),
    safeSearch: Schema.union([Schema.const(0), Schema.const(1), Schema.const(2)]).description("网页与图片搜索的安全过滤等级；实际效果取决于实例。"),
  }).description("通用搜索偏好"),
  Schema.object({
    engines: Schema.array(Schema.string()).default([]).description("仅网页搜索的默认引擎列表；图片搜索使用实例中已启用的图片引擎，不继承此列表。"),
    categories: Schema.array(Schema.string()).default([]).description("仅网页搜索的默认分类；图片搜索固定使用 images 分类，不继承此列表。"),
  }).description("仅网页搜索默认值"),
]);
const searchInputSchema = jsonSchema<SearXNGSearchInput>({
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, description: "Search query." },
    limit: { type: "number", minimum: 1, description: "Maximum number of results." },
    engines: { type: "array", items: { type: "string" }, description: "Search engines to use." },
    language: { type: "string", description: "Search language." },
    categories: { type: "array", items: { type: "string" }, description: "Search categories." },
    timeRange: { type: "string", enum: ["day", "month", "year"], description: "Time range for search." },
    safeSearch: { type: "number", enum: [0, 1, 2], description: "Safe search level." },
  },
  required: ["query"],
});
const imageSearchInputSchema = jsonSchema<{ query: string; limit?: number }>({
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      pattern: "\\S",
      description: "Name the public person, character, or product to find reference images.",
    },
    limit: { type: "integer", minimum: 1, maximum: MAX_IMAGE_CANDIDATES },
  },
  required: ["query"],
  additionalProperties: false,
});

type SearXNGSafeSearch = 0 | 1 | 2;

type SearXNGTimeRange = "day" | "month" | "year";

export interface SearXNGConfig {
  endpoint: string;
  engines?: string[];
  language?: string;
  categories?: string[];
  safeSearch?: SearXNGSafeSearch;
  username?: string;
  password?: string;
}

interface SearXNGRuntimeConfig extends SearchRuntimeConfig, SearXNGConfig {}

interface SearXNGSearchInput {
  query: string;
  limit?: number;
  engines?: string[];
  language?: string;
  categories?: string[];
  timeRange?: SearXNGTimeRange;
  safeSearch?: SearXNGSafeSearch;
}

interface SearXNGResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  engine?: string;
  category?: string;
  img_src?: string;
}

interface SearXNGResponse {
  results?: SearXNGResult[];
}
class SearXNGBackend implements SearchBackend {
  public readonly name = "searxng";

  private readonly blacklist: RegExp[];

  constructor(
    private readonly ctx: Context,
    private readonly config: SearXNGRuntimeConfig,
    private readonly logger: Logger,
  ) {
    this.blacklist = compileBlacklist(config.blacklist);
  }

  public createSearchTool(): AgentTool<SearXNGSearchInput, WebSearchOutput> {
    return {
      name: "searxng_web_search",
      description: "Search the web for current information, news, facts, or web content. " + "Returns structured JSON with titles, URLs, and snippets.",
      inputSchema: searchInputSchema,
      execute: async (input) => this.search(input),
    };
  }

  public createImageSearchTool(): AgentTool<{ query: string; limit?: number }, ImageSearchOutput> {
    return {
      name: "searxng_image_search",
      description:
        "Find public reference-image candidates, not identity proof. Import a candidate with import_image_reference and inspect its pixels and source before generation. Never search for speculative private identities.",
      inputSchema: imageSearchInputSchema,
      execute: async (input) => {
        if (!input.query.trim() || input.query.length > 512)
          return {
            provider: this.name,
            query: "",
            results: [],
            error: { code: "invalid_query", message: "Provide a public-subject query of 1-512 characters." },
          };
        const headers: Record<string, string> = {};
        if (this.config.username && this.config.password)
          headers.Authorization = `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64")}`;
        try {
          const response = await this.ctx.http.get<SearXNGResponse>(normalizeSearchUrl(this.config.endpoint), {
            params: { q: input.query, format: "json", categories: "images", language: this.config.language, safesearch: this.config.safeSearch?.toString() },
            headers,
            timeout: this.config.timeoutMs,
          });
          const limit = Math.min(clampLimit(input.limit, this.config.defaultLimit, this.config.maxLimit), MAX_IMAGE_CANDIDATES);
          const results = normalizeImageCandidates(
            (Array.isArray(response.results) ? response.results : [])
              .slice(0, 64)
              .map((result) => ({ imageUrl: result.img_src, sourcePageUrl: result.url, title: result.title, description: result.content })),
            { blacklist: this.blacklist, limit },
          );
          return { provider: this.name, query: input.query, results };
        } catch {
          this.logger.error("[SearXNGBackend] Image search failed");
          return {
            provider: this.name,
            query: input.query,
            results: [],
            error: { code: "request_failed", message: "Image search failed. Retry later or ask the user for a reference image." },
          };
        }
      },
    };
  }

  private async search(input: SearXNGSearchInput): Promise<WebSearchOutput> {
    const limit = clampLimit(input.limit, this.config.defaultLimit, this.config.maxLimit);
    const engines = input.engines ?? this.config.engines;
    const categories = input.categories ?? this.config.categories;
    const params: Record<string, string | undefined> = {
      q: input.query,
      format: "json",
      engines: engines?.join(","),
      categories: categories?.join(","),
      language: input.language ?? this.config.language,
      time_range: input.timeRange,
      safesearch: input.safeSearch != null ? String(input.safeSearch) : this.config.safeSearch != null ? String(this.config.safeSearch) : undefined,
    };
    const headers: Record<string, string> = {};

    if (this.config.username && this.config.password) {
      const credentials = Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64");
      headers.Authorization = `Basic ${credentials}`;
    }

    try {
      const response = await this.ctx.http.get<SearXNGResponse>(normalizeSearchUrl(this.config.endpoint), { params, headers, timeout: this.config.timeoutMs });
      const rawResults = Array.isArray(response.results) ? response.results : [];
      const mapped = rawResults.map((result) => ({
        title: result.title ?? "",
        url: result.url ?? "",
        snippet: result.content ?? "",
        score: result.score,
        metadata: { ...(result.engine ? { engine: result.engine } : {}), ...(result.category ? { category: result.category } : {}) },
      }));
      const filtered = filterBlockedResults(mapped, this.blacklist);
      const deduped = dedupeByUrl(filtered).slice(0, limit);

      return { provider: this.name, query: input.query, results: deduped };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[SearXNGBackend] Search failed: ${message}`);
      return { provider: this.name, query: input.query, results: [], error: { message, code: "request_failed" } };
    }
  }
}
export function createSearXNGBackend(ctx: Context, config: SearXNGConfig | undefined, runtime: SearchRuntimeConfig, logger: Logger): SearchBackend {
  if (!config?.endpoint) {
    throw new Error("SearXNG provider requires searxng.endpoint to be configured");
  }

  return new SearXNGBackend(ctx, { ...runtime, ...config }, logger);
}

function normalizeSearchUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  if (trimmed.endsWith("/search")) return trimmed;
  return `${trimmed}/search`;
}
