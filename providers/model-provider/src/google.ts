import { createGoogleGenerativeAI, type GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModelMiddleware } from "ai";
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
export const imageToolResultSupport = "native" as const;

/**
 * NewAPI/CPA routes must explicitly opt into additional image formats. PNG/JPEG are the
 * conservative native baseline; WebP is not projected until the route has been verified.
 */
export const defaultImageToolResultMediaTypes = ["image/png", "image/jpeg"] as const satisfies readonly (
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
)[];

export const videoInputSupport = "native" as const;

export const googleVideoInputMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v3",
  transformParams: async ({ params }) => {
    let userInput: Extract<(typeof params.prompt)[number], { role: "user" }> | undefined;
    const prompt = params.prompt.map((message) => {
      if (message.role === "user") {
        userInput = { ...message, content: [...message.content] };
        return userInput;
      }
      if (message.role !== "tool") return message;
      return {
        ...message,
        content: message.content.map((result) => {
          if (result.type !== "tool-result" || result.output.type !== "content") return result;
          const value = result.output.value.filter((part) => {
            if (part.type !== "file-data" || !part.mediaType.startsWith("video/")) return true;
            if (!userInput) throw new Error("Google video projection requires a preceding user input");
            // Video is supported as user media, not inside Gemini functionResponse.parts.
            userInput.content.push({ ...part, type: "file" });
            return false;
          });
          return { ...result, output: { ...result.output, value } };
        }),
      };
    });
    return { ...params, prompt };
  },
};

export const Config: Schema<Config> = Schema.object({
  id: Schema.string().default("google").description("提供商标识"),
  apiKey: Schema.string().role("secret").required().description("API Key"),
  baseURL: Schema.string().description("API Base URL"),
  imageToolResultMediaTypes: Schema.array(
    Schema.union([Schema.const("image/png"), Schema.const("image/jpeg"), Schema.const("image/gif"), Schema.const("image/webp")]),
  )
    .default([...defaultImageToolResultMediaTypes])
    .description("原生图片工具结果允许的 MIME 类型；未验证的网关线路不要加入 WebP"),
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

export interface Config extends BaseProviderConfig {
  imageToolResultMediaTypes?: ("image/png" | "image/jpeg" | "image/gif" | "image/webp")[];
}

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
        if (resolution?.clamped && !warned.has(modelId)) {
          warned.add(modelId);
          ctx
            .logger("yesimbot.provider.google")
            .warn(`Thinking level "${resolution.requested}" is not available for "${config.id}:${modelId}"; using "${resolution.level}".`);
        }
        return wrapLanguageModel({
          model,
          middleware: [
            googleVideoInputMiddleware,
            ...(resolution?.providerOptions ? [defaultSettingsMiddleware({ settings: { providerOptions: { google: resolution.providerOptions } } })] : []),
          ],
        });
      },
      chatCapabilities: () => ({
        imageToolResult: imageToolResultSupport,
        imageToolResultMediaTypes: config.imageToolResultMediaTypes ?? defaultImageToolResultMediaTypes,
        videoInput: videoInputSupport,
        historyProjection: "gemini-native" as const,
      }),
      embedding: (modelId: string) => client.embedding(modelId),
    });
    ctx.on("dispose", dispose);
  });
}

function isGoogleNativeThinkingLevel(value: string | undefined): value is GoogleNativeThinkingLevel {
  return value === "minimal" || value === "low" || value === "medium" || value === "high";
}
