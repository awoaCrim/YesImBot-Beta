import { createAnthropic } from "@ai-sdk/anthropic";
import { defaultSettingsMiddleware, wrapLanguageModel, type ToolSet } from "ai";
import { Context, Schema } from "koishi";
import {
  type BaseProviderConfig,
  type ChatModelConfig,
  createThinkingLevelMapSchema,
  resolveThinkingLevel,
  THINKING_LEVELS,
  type ThinkingLevel,
  type ThinkingLevelMap,
} from "koishi-plugin-yesimbot";
export const name = "yesimbot-provider-anthropic";

export const usage = "Anthropic 提供商插件";

export const inject = ["yesimbot"];

export const imageToolResultSupport = "native" as const;

export const Config: Schema<Config> = Schema.object({
  id: Schema.string().default("anthropic").description("提供商标识"),
  apiKey: Schema.string().role("secret").required().description("API Key"),
  baseURL: Schema.string().description("API Base URL"),
  webSearch: Schema.boolean().default(false).description("启用原生 Web 搜索"),
  chatModels: Schema.array(
    Schema.object({
      id: Schema.string().required().description("模型 ID"),
      toolCall: Schema.boolean().default(true).description("工具调用"),
      reasoning: Schema.boolean().default(false).description("推理"),
      thinkingLevel: Schema.union(THINKING_LEVELS.map((level) => Schema.const(level))).description("思考等级；留空时使用 Anthropic 默认行为"),
      thinkingLevelMap: createThinkingLevelMapSchema(["low", "medium", "high", "xhigh", "max"]).description(
        "逐模型覆写通用等级到 Anthropic effort；null 表示该等级不可用，off 固定映射为 thinking disabled",
      ),
    }),
  )
    .role("table")
    .default([
      { id: "claude-opus-4-6", toolCall: true, reasoning: true },
      { id: "claude-sonnet-4-6", toolCall: true, reasoning: true },
      { id: "claude-haiku-4-5-20251001", toolCall: true, reasoning: true },
    ] as never)
    .description("可用聊天模型列表"),
});

const ANTHROPIC_DEFAULT_THINKING_LEVELS: ThinkingLevelMap = { off: "off", low: "low", medium: "medium", high: "high" };

type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

type AnthropicThinkingOptions = { readonly effort: AnthropicEffort } | { readonly thinking: { readonly type: "disabled" } };

export interface Config extends BaseProviderConfig {
  webSearch: boolean;
}

interface AnthropicThinkingResolution {
  readonly clamped: boolean;
  readonly level: ThinkingLevel;
  readonly providerOptions: AnthropicThinkingOptions | undefined;
  readonly requested: ThinkingLevel;
}

export function resolveAnthropicThinkingOptions(entry: ChatModelConfig): AnthropicThinkingResolution | undefined {
  if (entry.thinkingLevel === undefined) return undefined;

  const resolved = resolveThinkingLevel(
    {
      defaultMap: ANTHROPIC_DEFAULT_THINKING_LEVELS,
      isNativeValue: isAnthropicEffort,
      reasoning: entry.reasoning,
      thinkingLevelMap: entry.thinkingLevelMap,
    },
    entry.thinkingLevel,
  );
  return {
    clamped: resolved.clamped,
    level: resolved.level,
    providerOptions: anthropicProviderOptions(resolved.level, resolved.native),
    requested: entry.thinkingLevel,
  };
}

export function apply(ctx: Context, config: Config) {
  const warned = new Set<string>();

  ctx.on("ready", () => {
    const client = createAnthropic({ apiKey: config.apiKey, baseURL: config.baseURL });
    const dispose = ctx.yesimbot.model.register({
      id: config.id,
      capabilities: { chat: true, embedding: false },
      chatModels: () => config.chatModels,
      embeddingModels: () => [],
      chat: (modelId: string, modelConfig?: ChatModelConfig) => {
        const model = client.chat(modelId);
        const entry = modelConfig ?? config.chatModels.find((item) => item.id === modelId);
        const resolution = entry ? resolveAnthropicThinkingOptions(entry) : undefined;
        if (!resolution) return model;

        if (resolution.clamped && !warned.has(modelId)) {
          warned.add(modelId);
          ctx
            .logger("yesimbot.provider.anthropic")
            .warn(`Thinking level "${resolution.requested}" is not available for "${config.id}:${modelId}"; using "${resolution.level}".`);
        }
        if (!resolution.providerOptions) return model;

        return wrapLanguageModel({
          model,
          middleware: [defaultSettingsMiddleware({ settings: { providerOptions: { anthropic: resolution.providerOptions } } })],
        });
      },
      chatCapabilities: () => ({ imageToolResult: imageToolResultSupport }),
      embedding: () => {
        throw new Error(`Provider "${config.id}" does not support embedding`);
      },
      tools: (): ToolSet => (config.webSearch ? { web_search: client.tools.webSearch_20250305() } : {}),
    });
    ctx.on("dispose", dispose);
  });
}

function anthropicProviderOptions(level: ThinkingLevel, native: string | undefined): AnthropicThinkingOptions | undefined {
  if (level === "off") return { thinking: { type: "disabled" } };
  return isAnthropicEffort(native) ? { effort: native } : undefined;
}

function isAnthropicEffort(value: string | undefined): value is AnthropicEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}
