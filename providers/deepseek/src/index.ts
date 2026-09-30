import { createDeepSeek, type DeepSeekLanguageModelOptions } from "@ai-sdk/deepseek";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
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
export const name = "yesimbot-provider-deepseek";

export const usage = "DeepSeek 提供商插件";

export const inject = ["yesimbot"];

export const Config: Schema<Config> = Schema.object({
  id: Schema.string().default("deepseek").description("提供商标识"),
  apiKey: Schema.string().role("secret").required().description("API Key"),
  baseURL: Schema.string().description("API Base URL"),
  thinking: Schema.union([
    Schema.const("auto").description("自适应"),
    Schema.const("none").description("关闭"),
    Schema.const("low").description("低"),
    Schema.const("medium").description("中"),
    Schema.const("high").description("高"),
    Schema.const("xhigh").description("极高"),
    Schema.const("max").description("最大"),
  ])
    .default("high")
    .description("默认思考等级（模型 ID 可用 :level 覆盖；模型行 thinkingLevel 优先于本项）"),
  chatModels: Schema.array(
    Schema.object({
      id: Schema.string().required().description("模型 ID"),
      toolCall: Schema.boolean().default(true).description("工具调用"),
      reasoning: Schema.boolean().default(false).description("推理"),
      thinkingLevel: Schema.union(THINKING_LEVELS.map((level) => Schema.const(level))).description("思考等级；留空时使用上方默认思考等级"),
      thinkingLevelMap: createThinkingLevelMapSchema(["low", "medium", "high", "xhigh", "max"]).description(
        "逐模型覆写通用等级到 DeepSeek reasoningEffort；null 表示该等级不可用，off 固定映射为 thinking disabled",
      ),
    }),
  )
    .role("table")
    .default([
      { id: "deepseek-v4-flash", toolCall: true, reasoning: true },
      { id: "deepseek-v4-pro", toolCall: true, reasoning: true },
    ] as never)
    .description("可用聊天模型列表"),
});

const DEEPSEEK_LEGACY_THINKING_LEVELS = ["auto", "none", "low", "medium", "high", "xhigh", "max"] as const;

const DEEPSEEK_DEFAULT_THINKING_LEVELS: ThinkingLevelMap = { off: "off", low: "low", medium: "medium", high: "high" };

type DeepSeekLegacyThinkingLevel = (typeof DEEPSEEK_LEGACY_THINKING_LEVELS)[number];

type DeepSeekReasoningEffort = NonNullable<DeepSeekLanguageModelOptions["reasoningEffort"]>;

interface Config extends BaseProviderConfig {
  thinking: DeepSeekLegacyThinkingLevel;
}

interface DeepSeekThinkingResolution {
  readonly actualId: string;
  readonly clamped: boolean;
  readonly level: ThinkingLevel | undefined;
  readonly options: DeepSeekLanguageModelOptions;
  readonly requested: ThinkingLevel | undefined;
}

export function resolveDeepSeekThinking(modelId: string, entry: ChatModelConfig, globalThinking: DeepSeekLegacyThinkingLevel): DeepSeekThinkingResolution {
  const colonIndex = modelId.lastIndexOf(":");
  if (colonIndex > 0) {
    const suffix = modelId.slice(colonIndex + 1);
    if (isDeepSeekLegacyThinkingLevel(suffix)) {
      return { actualId: modelId.slice(0, colonIndex), clamped: false, level: undefined, options: deepSeekLegacyOptions(suffix), requested: undefined };
    }
  }

  if (entry.thinkingLevel !== undefined) {
    const resolved = resolveThinkingLevel(
      {
        defaultMap: DEEPSEEK_DEFAULT_THINKING_LEVELS,
        isNativeValue: isDeepSeekReasoningEffort,
        reasoning: entry.reasoning,
        thinkingLevelMap: entry.thinkingLevelMap,
      },
      entry.thinkingLevel,
    );
    const options = resolved.level === "off" ? { thinking: { type: "disabled" as const } } : deepSeekEnabledOptions(resolved.native);
    if (options) {
      return { actualId: modelId, clamped: resolved.clamped, level: resolved.level, options, requested: entry.thinkingLevel };
    }
  }

  return { actualId: modelId, clamped: false, level: undefined, options: deepSeekLegacyOptions(globalThinking), requested: undefined };
}

export function apply(ctx: Context, config: Config) {
  const client = createDeepSeek({ apiKey: config.apiKey, baseURL: config.baseURL });
  const warned = new Set<string>();
  const dispose = ctx.yesimbot.model.register({
    id: config.id,
    capabilities: { chat: true, embedding: false },
    chatModels: () => config.chatModels,
    embeddingModels: () => [],
    chat: (modelId: string, modelConfig?: ChatModelConfig) => {
      const entry = modelConfig ?? config.chatModels.find((item) => item.id === modelId) ?? { id: modelId };
      const resolution = resolveDeepSeekThinking(modelId, entry, config.thinking);

      if (resolution.clamped && resolution.requested !== undefined && !warned.has(modelId)) {
        warned.add(modelId);
        ctx
          .logger("yesimbot.provider.deepseek")
          .warn(`Thinking level "${resolution.requested}" is not available for "${config.id}:${modelId}"; using "${resolution.level}".`);
      }

      return wrapLanguageModel({
        model: client.chat(resolution.actualId),
        middleware: [defaultSettingsMiddleware({ settings: { providerOptions: { deepseek: resolution.options } } })],
      });
    },
    embedding: () => {
      throw new Error(`Provider "${config.id}" does not support embedding`);
    },
  });
  ctx.on("dispose", dispose);
}

function deepSeekEnabledOptions(native: string | undefined): DeepSeekLanguageModelOptions | undefined {
  return isDeepSeekReasoningEffort(native) ? { thinking: { type: "enabled" }, reasoningEffort: native } : undefined;
}

function deepSeekLegacyOptions(level: DeepSeekLegacyThinkingLevel): DeepSeekLanguageModelOptions {
  if (level === "none") return { thinking: { type: "disabled" } };
  if (level === "auto") return { thinking: { type: "adaptive" } };
  return { thinking: { type: "enabled" }, reasoningEffort: level };
}

function isDeepSeekLegacyThinkingLevel(value: string): value is DeepSeekLegacyThinkingLevel {
  return DEEPSEEK_LEGACY_THINKING_LEVELS.some((level) => level === value);
}

function isDeepSeekReasoningEffort(value: string | undefined): value is DeepSeekReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}
