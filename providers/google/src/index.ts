import { createGoogleGenerativeAI, type GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
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
export const name = "yesimbot-provider-google";

export const usage = "Google 提供商插件";

export const inject = ["yesimbot"];

export const imageToolResultSupport = "native" as const;

export const Config: Schema<Config> = Schema.object({
  id: Schema.string().default("google").description("提供商标识"),
  apiKey: Schema.string().role("secret").required().description("API Key"),
  baseURL: Schema.string().description("API Base URL"),
  chatModels: Schema.array(
    Schema.object({
      id: Schema.string().required().description("模型 ID"),
      toolCall: Schema.boolean().default(true).description("工具调用"),
      reasoning: Schema.boolean().default(false).description("推理"),
      thinkingLevel: Schema.union(THINKING_LEVELS.map((level) => Schema.const(level))).description("思考等级；留空时使用 Google 默认行为"),
      thinkingLevelMap: createThinkingLevelMapSchema(["minimal", "low", "medium", "high"]).description(
        "逐模型覆写通用等级到 Google 原生 thinkingLevel 值；null 表示该等级不可用",
      ),
    }),
  )
    .role("table")
    .default([
      { id: "gemini-2.5-flash", toolCall: true, reasoning: true },
      { id: "gemini-2.5-pro", toolCall: true, reasoning: true },
      { id: "gemini-3.1-pro-preview", toolCall: true, reasoning: true },
      { id: "gemini-3.5-flash", toolCall: true, reasoning: true },
    ] as never)
    .description("可用聊天模型列表"),
  embeddingModels: Schema.array(Schema.object({ id: Schema.string().required().description("模型 ID") }))
    .role("table")
    .default([])
    .description("可用嵌入模型列表"),
});

const GOOGLE_DEFAULT_THINKING_LEVELS: ThinkingLevelMap = { minimal: "minimal", low: "low", medium: "medium", high: "high" };

type GoogleNativeThinkingLevel = "minimal" | "low" | "medium" | "high";

interface Config extends BaseProviderConfig {}

interface GoogleThinkingResolution {
  readonly clamped: boolean;
  readonly level: ThinkingLevel;
  readonly providerOptions: GoogleGenerativeAIProviderOptions | undefined;
  readonly requested: ThinkingLevel;
}

export function resolveGoogleThinkingOptions(entry: ChatModelConfig): GoogleThinkingResolution | undefined {
  if (entry.thinkingLevel === undefined) return undefined;

  const resolved = resolveThinkingLevel(
    {
      defaultMap: GOOGLE_DEFAULT_THINKING_LEVELS,
      isNativeValue: isGoogleNativeThinkingLevel,
      reasoning: entry.reasoning,
      thinkingLevelMap: entry.thinkingLevelMap,
    },
    entry.thinkingLevel,
  );
  const native = isGoogleNativeThinkingLevel(resolved.native) ? resolved.native : undefined;
  return {
    clamped: resolved.clamped,
    level: resolved.level,
    providerOptions: native ? { thinkingConfig: { thinkingLevel: native } } : undefined,
    requested: entry.thinkingLevel,
  };
}

export function apply(ctx: Context, config: Config) {
  const warned = new Set<string>();

  ctx.on("ready", () => {
    const client = createGoogleGenerativeAI({ apiKey: config.apiKey, baseURL: config.baseURL });
    const dispose = ctx.yesimbot.model.register({
      id: config.id,
      capabilities: { chat: true, embedding: true },
      chatModels: () => config.chatModels,
      embeddingModels: () => config.embeddingModels ?? [],
      chat: (modelId: string, modelConfig?: ChatModelConfig) => {
        const model = client.chat(modelId);
        const entry = modelConfig ?? config.chatModels.find((item) => item.id === modelId);
        const resolution = entry ? resolveGoogleThinkingOptions(entry) : undefined;
        if (!resolution) return model;

        if (resolution.clamped && !warned.has(modelId)) {
          warned.add(modelId);
          ctx
            .logger("yesimbot.provider.google")
            .warn(`Thinking level "${resolution.requested}" is not available for "${config.id}:${modelId}"; using "${resolution.level}".`);
        }
        if (!resolution.providerOptions) return model;

        return wrapLanguageModel({
          model,
          middleware: [defaultSettingsMiddleware({ settings: { providerOptions: { google: resolution.providerOptions } } })],
        });
      },
      chatCapabilities: () => ({ imageToolResult: imageToolResultSupport, historyProjection: "gemini-native" as const }),
      embedding: (modelId: string) => client.embedding(modelId),
    });
    ctx.on("dispose", dispose);
  });
}

function isGoogleNativeThinkingLevel(value: string | undefined): value is GoogleNativeThinkingLevel {
  return value === "minimal" || value === "low" || value === "medium" || value === "high";
}
