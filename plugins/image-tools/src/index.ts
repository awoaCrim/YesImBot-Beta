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

export const Config: Schema<ImageToolsConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description("是否启用 generate_image 与 edit_image 工具"),
  apiKey: Schema.string().role("secret").required().description("OpenAI-compatible API Key"),
  baseURL: Schema.string().description("OpenAI-compatible Images API Base URL"),
  model: Schema.string().description("图片生成模型 ID；enabled=true 时必填"),
  editModel: Schema.string().description("图片编辑模型 ID；留空时沿用图片生成模型"),
  timeout: Schema.number().min(1).max(600).default(DEFAULT_IMAGE_TIMEOUT_SECONDS).description("单次图片操作超时（秒）"),
});

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
          createGenerateImageTool({ imageModel: client.image(modelId), modelId, timeoutMs, resources, imageProjection, budget }),
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
