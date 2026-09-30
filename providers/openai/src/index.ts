import { createOpenAI } from "@ai-sdk/openai";
import type { ToolSet } from "ai";
import { Context, Schema } from "koishi";
import { type BaseProviderConfig, type ImageToolResultSupport } from "koishi-plugin-yesimbot";

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
      }),
    )
      .role("table")
      .default([
        { id: "gpt-4o", toolCall: true, reasoning: true },
        { id: "gpt-5.4", toolCall: true, reasoning: true },
        { id: "gpt-5.5", toolCall: true, reasoning: true },
        { id: "gpt-5.6-luna", toolCall: true, reasoning: true },
      ])
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

interface Config extends BaseProviderConfig {
  format: "chat" | "responses";
  imageToolResultSupport?: ImageToolResultSupport;
  imageToolResultPlacement?: "tool-output" | "user-message";
  webSearch?: boolean;
}

export function imageToolResultSupportForFormat(format: Config["format"], override?: ImageToolResultSupport): ImageToolResultSupport {
  return override ?? (format === "responses" ? "native" : "unsupported");
}

export function apply(ctx: Context, config: Config) {
  const client = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  let disposeProvider: (() => void) | undefined;

  ctx.on("ready", () => {
    const imageToolResultSupport = imageToolResultSupportForFormat(config.format, config.imageToolResultSupport);
    const imageToolResultPlacement = config.imageToolResultPlacement ?? "tool-output";
    disposeProvider = ctx.yesimbot.model.register({
      id: config.id,
      capabilities: { chat: true, embedding: true },
      chatModels: () => config.chatModels,
      embeddingModels: () => config.embeddingModels ?? [],
      chat: (modelId: string) => {
        const model = config.format === "responses" ? client.responses(modelId) : client.chat(modelId);
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
