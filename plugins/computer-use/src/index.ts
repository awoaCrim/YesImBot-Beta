import { EphemeralImageProjectionStore, type AgentPlugin, type ToolFilterContext } from "@yesimbot/agent-runtime";
import { Context, Schema } from "koishi";
import {
  DEFAULT_MANAGEMENT_TOOL_SCOPES,
  extractToolAccessActorIds,
  isToolAccessAllowed,
  isToolAccessPotentiallyAllowed,
  type ToolAccessRule,
} from "koishi-plugin-yesimbot";

import { McpDesktopDriver } from "./driver.js";
import { createResponsesRequester } from "./responses.js";
import { createComputerUseTool } from "./tool.js";

export const name = "yesimbot-computer-use";

export const usage = "通过 OpenAI Responses 原生 computer tool 驱动隔离 Anon 桌面";

export const inject = ["yesimbot"];

export const reusable = true;

export const Config: Schema<ComputerUseConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description("是否注册 computer_use 委托工具"),
  apiKey: Schema.string().role("secret").required().description("用于 Responses API 的 API Key"),
  baseURL: Schema.string().default("https://api.openai.com/v1").description("Responses API Base URL"),
  model: Schema.string().required().description("支持原生 computer tool 的 Responses 模型 ID"),
  toolType: Schema.union([Schema.const("computer"), Schema.const("computer_use_preview")])
    .default("computer")
    .description("原生 computer tool 类型；新 GA 模型使用 computer，旧 preview 模型使用 computer_use_preview"),
  environment: Schema.union([Schema.const("computer"), Schema.const("browser")])
    .default("computer")
    .description("preview computer tool 的环境类型"),
  displayWidth: Schema.number().min(1).max(16_384).default(1280).description("preview computer tool 的显示宽度"),
  displayHeight: Schema.number().min(1).max(16_384).default(800).description("preview computer tool 的显示高度"),
  mcpEndpoint: Schema.string().default("http://172.20.0.1:18200/sse").description("固定 Anon 来宾桌面 MCP SSE 地址"),
  maxSteps: Schema.number().min(1).max(50).default(20).description("单次原生桌面任务最多执行的模型步骤"),
  timeout: Schema.number().min(10).max(600).default(180).description("单次桌面任务超时（秒）"),
  allowedScopes: Schema.array(
    Schema.object({
      platform: Schema.string().required().description("平台名称；* 匹配任意平台"),
      channelId: Schema.string().required().description("频道 ID；* 匹配任意频道"),
      userId: Schema.string().description("可选的用户 ID；群聊按当前消息发送者匹配；留空则仅按平台、频道和机器人账号匹配"),
      selfId: Schema.string().description("可选的机器人账号 ID；留空匹配全部机器人"),
    }),
  )
    .role("table")
    .default(DEFAULT_MANAGEMENT_TOOL_SCOPES.map((scope) => ({ ...scope, selfId: "" })))
    .description(
      "原生桌面工具白名单；规则按 OR 合并、字段按 AND 匹配，不额外区分私聊和群聊；群聊中的 userId 按当前消息发送者匹配。默认授权 OneBot 用户 QQ 1049700117",
    ),
});

export interface ComputerUseConfig {
  enabled?: boolean;
  apiKey: string;
  baseURL?: string;
  model: string;
  toolType?: "computer" | "computer_use_preview";
  environment?: "computer" | "browser";
  displayWidth?: number;
  displayHeight?: number;
  mcpEndpoint?: string;
  maxSteps?: number;
  timeout?: number;
  allowedScopes?: ToolAccessRule[];
}

export function apply(ctx: Context, config: ComputerUseConfig): void {
  if (config.enabled === false) return;

  const requester = createResponsesRequester({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: requireValue(config.model, "model"),
    toolType: config.toolType,
    environment: config.environment,
    displayWidth: config.displayWidth,
    displayHeight: config.displayHeight,
    maxSteps: config.maxSteps ?? 20,
  });
  const dispose = ctx.yesimbot.agent.use({
    async setup(scope, bot, runtime): Promise<AgentPlugin> {
      const accessScope = scope.selfId === undefined ? { ...scope, selfId: bot.selfId } : scope;
      const rules = config.allowedScopes ?? DEFAULT_MANAGEMENT_TOOL_SCOPES;
      if (!isToolAccessPotentiallyAllowed(accessScope, rules)) {
        return { name: "computer-use", tools: [] };
      }
      const imageProjection = runtime?.imageProjection ?? new EphemeralImageProjectionStore();
      const tool = createComputerUseTool({
        imageProjection,
        requester,
        driverFactory: () => new McpDesktopDriver({ endpoint: requireValue(config.mcpEndpoint, "mcpEndpoint") }),
        maxSteps: config.maxSteps ?? 20,
        timeoutMs: (config.timeout ?? 180) * 1000,
      });
      const toolNames = new Set([tool.name]);
      const isAllowed = (messages: ToolFilterContext["messages"]) => isToolAccessAllowed(accessScope, rules, extractToolAccessActorIds(messages));
      return {
        name: "computer-use",
        tools: [tool],
        filterTools: (candidates, filterContext) =>
          isAllowed(filterContext.messages) ? candidates : candidates.filter((candidate) => !toolNames.has(candidate.name)),
        beforeToolCall: (call, hookContext) =>
          toolNames.has(call.toolName) && !isAllowed(hookContext.messages)
            ? { type: "block", reason: "当前消息发送者不在原生桌面工具白名单中" }
            : { type: "allow" },
        appendSystemPrompt: () =>
          "已注册原生 computer_use：需要可见浏览器或 Linux 桌面时，把完整任务委托给它。不要把坐标拆成普通 MCP 调用；必须根据返回截图确认实际结果。若返回 safety_check_required，先向用户确认，不能声称动作完成。",
        onTurnFinish: (_result, context) => imageProjection.clearTurn(context.turnId),
        stop: () => imageProjection.clearAll(),
      };
    },
  });
  ctx.on("dispose", dispose);
}

function requireValue(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`yesimbot-computer-use requires ${name}`);
  return normalized;
}

export { McpDesktopDriver } from "./driver.js";

export { createResponsesRequester, runResponsesComputerUse, ResponsesApiError } from "./responses.js";

export { createComputerUseTool } from "./tool.js";

export type * from "./types.js";
