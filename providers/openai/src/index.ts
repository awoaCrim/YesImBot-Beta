import { createOpenAI, type OpenAIChatLanguageModelOptions } from "@ai-sdk/openai";
import { defaultSettingsMiddleware, wrapLanguageModel, type ToolSet } from "ai";
import { Context, Schema } from "koishi";
import {
  type BaseProviderConfig,
  type ChatModelConfig,
  createThinkingLevelMapSchema,
  type ImageToolResultSupport,
  resolveThinkingLevel,
  THINKING_LEVELS,
  type ThinkingLevel,
  type ThinkingLevelMap,
} from "koishi-plugin-yesimbot";

import { withUserMessageImageToolResults } from "./image-tool-result.js";
export const name = "yesimbot-provider-openai";

export const usage = "OpenAI 提供商插件";

export const inject = ["yesimbot"];

export const reusable = true;

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    id: Schema.string().default("openai").description("提供商标识"),
    apiKey: Schema.string().role("secret").required().description("API Key"),
    baseURL: Schema.string().description("API Base URL"),
    format: Schema.union([Schema.const("chat"), Schema.const("responses")])
      .default("chat")
      .description("API 格式"),
    imageToolResultSupport: Schema.union([
      Schema.const("native").description("原生结构化图片工具结果"),
      Schema.const("unsupported").description("不支持图片工具结果，改用视觉模型回退"),
      Schema.const("unknown").description("能力未知，按不支持处理"),
    ]).description("图片工具结果能力覆盖；留空时按 API 格式推导"),
    imageToolResultPlacement: Schema.union([
      Schema.const("tool-output").description("图片保留在工具结果中"),
      Schema.const("user-message").description("图片提升为当前请求的临时用户消息"),
    ])
      .default("tool-output")
      .description("原生图片工具结果的请求位置"),
    chatModels: Schema.array(
      Schema.object({
        id: Schema.string().required().description("模型 ID"),
        toolCall: Schema.boolean().default(true).description("工具调用"),
        reasoning: Schema.boolean().default(false).description("推理"),
        thinkingLevel: Schema.union(THINKING_LEVELS.map((level) => Schema.const(level))).description("思考等级；留空时使用 OpenAI 默认行为"),
        thinkingLevelMap: createThinkingLevelMapSchema(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).description(
          "逐模型覆写通用等级到 OpenAI reasoningEffort；null 表示该等级不可用",
        ),
      }),
    )
      .role("table")
      .default([
        { id: "gpt-4o", toolCall: true, reasoning: true },
        { id: "gpt-5.4", toolCall: true, reasoning: true },
        { id: "gpt-5.5", toolCall: true, reasoning: true },
        { id: "gpt-5.6-luna", toolCall: true, reasoning: true },
      ] as never)
      .description("可用聊天模型列表"),
    embeddingModels: Schema.array(Schema.object({ id: Schema.string().required().description("模型 ID") }))
      .role("table")
      .default([{ id: "text-embedding-3-small" }, { id: "text-embedding-3-large" }])
      .description("可用嵌入模型列表"),
  }),
  Schema.union([
    Schema.object({ format: Schema.const("chat") }),
    Schema.object({ format: Schema.const("responses"), webSearch: Schema.boolean().default(false).description("启用原生 Web 搜索") }),
  ]),
]);

const OPENAI_DEFAULT_THINKING_LEVELS: ThinkingLevelMap = { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high" };

type OpenAIReasoningEffort = NonNullable<OpenAIChatLanguageModelOptions["reasoningEffort"]>;

interface Config extends BaseProviderConfig {
  format: "chat" | "responses";
  imageToolResultSupport?: ImageToolResultSupport;
  imageToolResultPlacement?: "tool-output" | "user-message";
  webSearch?: boolean;
}

interface OpenAIThinkingResolution {
  readonly clamped: boolean;
  readonly level: ThinkingLevel;
  readonly providerOptions: { reasoningEffort: OpenAIReasoningEffort } | undefined;
  readonly requested: ThinkingLevel;
}

export function imageToolResultSupportForFormat(format: Config["format"], override?: ImageToolResultSupport): ImageToolResultSupport {
  return override ?? (format === "responses" ? "native" : "unsupported");
}

export function resolveOpenAIThinkingOptions(entry: ChatModelConfig): OpenAIThinkingResolution | undefined {
  if (entry.thinkingLevel === undefined) return undefined;

  const resolved = resolveThinkingLevel(
    {
      defaultMap: OPENAI_DEFAULT_THINKING_LEVELS,
      isNativeValue: isOpenAIReasoningEffort,
      reasoning: entry.reasoning,
      thinkingLevelMap: entry.thinkingLevelMap,
    },
    entry.thinkingLevel,
  );
  const effort = isOpenAIReasoningEffort(resolved.native) ? resolved.native : undefined;
  return {
    clamped: resolved.clamped,
    level: resolved.level,
    providerOptions: effort ? { reasoningEffort: effort } : undefined,
    requested: entry.thinkingLevel,
  };
}

export function apply(ctx: Context, config: Config) {
  const client = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  const warned = new Set<string>();
  let disposeProvider: (() => void) | undefined;

  ctx.on("ready", () => {
    const imageToolResultSupport = imageToolResultSupportForFormat(config.format, config.imageToolResultSupport);
    const imageToolResultPlacement = config.imageToolResultPlacement ?? "tool-output";
    disposeProvider = ctx.yesimbot.model.register({
      id: config.id,
      capabilities: { chat: true, embedding: true },
      chatModels: () => config.chatModels,
      embeddingModels: () => config.embeddingModels ?? [],
      chat: (modelId: string, modelConfig?: ChatModelConfig) => {
        const base = config.format === "responses" ? client.responses(modelId) : client.chat(modelId);
        const entry = modelConfig ?? config.chatModels.find((item) => item.id === modelId);
        const resolution = entry ? resolveOpenAIThinkingOptions(entry) : undefined;
        const model = resolution?.providerOptions
          ? wrapLanguageModel({
              model: base,
              middleware: [defaultSettingsMiddleware({ settings: { providerOptions: { openai: resolution.providerOptions } } })],
            })
          : base;

        if (resolution?.clamped && !warned.has(modelId)) {
          warned.add(modelId);
          ctx
            .logger("yesimbot.provider.openai")
            .warn(`Thinking level "${resolution.requested}" is not available for "${config.id}:${modelId}"; using "${resolution.level}".`);
        }
        return imageToolResultSupport === "native" && imageToolResultPlacement === "user-message" ? withUserMessageImageToolResults(model) : model;
      },
      embedding: (modelId: string) => client.embedding(modelId),
      chatCapabilities: () => ({ imageToolResult: imageToolResultSupport }),
      tools: (): ToolSet => (config.format === "responses" && config.webSearch ? { web_search: client.tools.webSearch({}) } : {}),
    });
  });

  ctx.on("dispose", () => {
    disposeProvider?.();
    disposeProvider = undefined;
  });
}

function isOpenAIReasoningEffort(value: string | undefined): value is OpenAIReasoningEffort {
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}
