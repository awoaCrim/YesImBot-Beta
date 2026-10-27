import { createOpenAI } from "@ai-sdk/openai";
import { EphemeralImageProjectionStore, type AgentPlugin } from "@yesimbot/agent-runtime";
import { Context, Schema } from "koishi";

import { createEditImageTool } from "./image-edit.js";
import { createGenerateImageTool, DEFAULT_IMAGE_TIMEOUT_SECONDS } from "./image-generation.js";
import { ImageOutputBudget } from "./image-output.js";

export const name = "yesimbot-image-tools";

export const usage = "OpenAI-compatible 图片生成与编辑工具插件";

export const inject = ["yesimbot"];

export const reusable = true;

export const Config: Schema<ImageToolsConfig> = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description("启用 generate_image 与 edit_image；图片检索由搜索服务提供。"),
    apiKey: Schema.string().role("secret").required().description("文生图、参考图生图与图片编辑共用的 API Key。"),
    baseURL: Schema.string().description("共用的 Images API 根地址（不含 /images/...）；参考图生图与编辑需支持 JSON images 协议。留空使用 SDK 默认地址。"),
  }).description("启用与连接"),
  Schema.object({
    model: Schema.string().description("默认图片模型 ID；启用工具时必填，用于纯文生图，editModel 留空时也用于参考图生图与编辑。"),
    editModel: Schema.string().description("参考图生图与图片编辑共用的模型 ID（/images/edits）；留空沿用 model。"),
  }).description("模型选择"),
  Schema.object({
    timeout: Schema.number()
      .min(1)
      .max(600)
      .default(DEFAULT_IMAGE_TIMEOUT_SECONDS)
      .description("生图请求（含参考图读取）与编辑请求的超时，单位为秒；不控制搜索、参考图下载、资源写入或 Core 视觉检查。"),
  }).description("请求限制"),
]);

export interface ImageToolsConfig {
  enabled?: boolean;
  apiKey: string;
  baseURL?: string;
  model?: string;
  editModel?: string;
  timeout?: number;
}

export function apply(ctx: Context, config: ImageToolsConfig): void {
  if (config.enabled === false) return;

  const modelId = requireImageModel(config.model);
  const editModelId = config.editModel?.trim() || modelId;
  const timeoutMs = (config.timeout ?? DEFAULT_IMAGE_TIMEOUT_SECONDS) * 1000;
  const client = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  const disposeAgentPlugin = ctx.yesimbot.agent.use({
    async setup(scope, _bot, runtime) {
      const resources = await ctx.yesimbot.resource.get(scope);
      const imageProjection = runtime?.imageProjection ?? new EphemeralImageProjectionStore();
      const budget = new ImageOutputBudget();
      return {
        name: "image-tools",
        tools: () => [
          createGenerateImageTool({
            imageModel: client.image(modelId),
            modelId,
            referenceModelId: editModelId,
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            timeoutMs,
            resources,
            imageProjection,
            budget,
          }),
          createEditImageTool({
            baseURL: config.baseURL,
            apiKey: config.apiKey,
            modelId: editModelId,
            timeoutMs,
            resources,
            imageProjection,
            budget,
          }),
        ],
        onTurnFinish: (_result, context) => {
          budget.clearTurn(context.turnId);
          imageProjection.clearTurn(context.turnId);
        },
        stop: () => {
          budget.clearAll();
          imageProjection.clearAll();
        },
      } satisfies AgentPlugin;
    },
  });

  ctx.on("dispose", () => {
    disposeAgentPlugin();
  });
}

function requireImageModel(model: string | undefined): string {
  const normalized = model?.trim();
  if (normalized) return normalized;
  throw new Error("yesimbot-image-tools requires model when image tools are enabled");
}
