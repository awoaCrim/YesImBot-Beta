import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { jsonSchema, type AgentPlugin, type AgentTool, type AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import { Context, Logger, Schema, type Bot } from "koishi";
import { DEFAULT_MANAGEMENT_TOOL_SCOPES, isToolAccessAllowed } from "koishi-plugin-yesimbot";
import type { ArtifactStore, ChannelContext } from "koishi-plugin-yesimbot";

import {
  ConfirmationStore,
  classifyToolRisk,
  deriveChannelScopeKey,
  hashArgs,
  inspectLatestConfirmationInput,
  pendingKey,
  type ConfirmationBlockReason,
  type PendingConfirmation,
} from "./confirmation.js";
import { connectMcpServer } from "./transports.js";
import type { McpClientConfig, McpClientTransport } from "./types.js";

/** ponytail: align MCP media with Core's default image-input budget. */
const MCP_IMAGE_MAX_COUNT = 4;
const MCP_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const MCP_IMAGE_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MCP_MAX_OUTPUT_CHARS = 30_000;
const MCP_MAX_BLOCK_TYPE_CHARS = 64;
const SUPPORTED_IMAGE_MIMES: Record<string, true> = { "image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true };
const MCP_ARTIFACT_GUIDANCE =
  "MCP 工具可能返回 artifact:// 媒体引用。这些是工具产生的不可变工件，不是内联媒体；" +
  "需要媒体内容时请调用 Core 的 read 工具。媒体不会是 Base64，远端 URL 也不会被自动下载。";
const MCP_CONFIRMATION_GUIDANCE =
  "部分 MCP 工具会产生外部副作用。返回 confirmation_required 的调用没有被执行，也不代表操作已完成；" +
  "必须让用户在同一频道回复精确的「确认 <短码>」；若确认绑定已含发送者身份，后续消息必须保留可信原始身份并由同一发送者确认，身份丢失时不会执行。" +
  "不得自行编造或复用短码，也不得自行填写确认字段；参数变化、短码错误或确认过期后必须重新向用户确认。";

interface McpToolOutputBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface McpToolEntry {
  readonly serverName: string;
  readonly upstreamToolName: string;
  readonly requiresConfirmation: boolean;
  readonly tool: AgentTool;
}

export default class McpClientPlugin {
  public static name = "yesimbot-mcp-client";
  public static usage = "MCP 客户端插件，用于连接 MCP 服务器并注册工具";
  public static inject = ["yesimbot"];
  public static Config: Schema<McpClientConfig> = Schema.object({
    allowedScopes: Schema.array(
      Schema.object({
        platform: Schema.string().required().description("平台名称；* 匹配任意平台"),
        channelId: Schema.string().required().description("频道 ID；私聊按 QQ 号授权时填写 *"),
        userId: Schema.string().description("私聊 QQ 号；群聊/频道规则留空"),
        selfId: Schema.string().description("可选的机器人账号 ID；留空匹配全部机器人"),
      }),
    )
      .role("table")
      .default(DEFAULT_MANAGEMENT_TOOL_SCOPES.map((scope) => ({ ...scope, selfId: "" })))
      .description("MCP 工具白名单；默认授权 QQ 1049700117 的 OneBot 私聊，设置为空数组可拒绝全部工具。私聊按 QQ 号，群聊/频道按 channelId 授权"),
    mcpServers: Schema.dict(
      Schema.intersect([
        Schema.object({ enable: Schema.boolean().default(true).description("是否启用"), type: Schema.union(["stdio", "http", "sse"]) }),
        Schema.union([
          Schema.object({
            type: Schema.const("stdio").required(),
            command: Schema.string().required(),
            args: Schema.array(Schema.string()).default([]).role("table"),
            env: Schema.union([
              Schema.dict(Schema.string()).default({}).role("table").description("字典"),
              Schema.string().role("textarea").description("字符串，格式为 KEY=VALUE，每行一个"),
            ]).description("环境变量"),
          }),
          Schema.object({
            type: Schema.const("http").required(),
            url: Schema.string().required(),
            headers: Schema.union([
              Schema.dict(Schema.string()).default({}).role("table").description("字典"),
              Schema.string().role("textarea").description("字符串，格式为 KEY: VALUE，每行一个"),
            ]).description("HTTP 请求头"),
            bearerTokenFile: Schema.string().description(
              "owner-only（600）文件路径，文件内为单行 Bearer token；与显式 Authorization 请求头互斥，读取失败即拒绝连接",
            ),
          }),
          Schema.object({
            type: Schema.const("sse").required(),
            url: Schema.string().required(),
            headers: Schema.union([
              Schema.dict(Schema.string()).default({}).role("table").description("字典"),
              Schema.string().role("textarea").description("字符串，格式为 KEY: VALUE，每行一个"),
            ]).description("HTTP 请求头"),
            bearerTokenFile: Schema.string().description(
              "owner-only（600）文件路径，文件内为单行 Bearer token；与显式 Authorization 请求头互斥，读取失败即拒绝连接",
            ),
          }),
        ]),
      ]).collapse(true),
    ),
  });

  public readonly ctx: Context;
  public readonly config: McpClientConfig;
  public readonly logger: Logger;

  private readonly confirmationStores = new Set<ConfirmationStore>();
  private transports: Map<string, McpClientTransport> = new Map();
  private clients: Map<string, Client> = new Map();
  private registeredTools: McpToolEntry[] = [];
  private disposeAgentPlugin?: () => void;

  public constructor(ctx: Context, config: McpClientConfig) {
    this.ctx = ctx;
    this.config = config;
    this.logger = ctx.logger("mcp-client");
    ctx.on("ready", this.start.bind(this));
    ctx.on("dispose", this.stop.bind(this));
  }

  public async setup(scope: ChannelContext, _bot: Bot): Promise<AgentPlugin> {
    if (!isToolAccessAllowed(scope, this.config.allowedScopes)) {
      return { name: "mcp-client", tools: [] };
    }

    const resources = await this.ctx.yesimbot.resource.get(scope);
    const scopeKey = deriveChannelScopeKey(scope);
    const confirmations = new ConfirmationStore(() => Date.now());
    this.confirmationStores.add(confirmations);
    const channelTools = this.registeredTools.map((entry) =>
      wrapToolWithArtifacts(this.withConfirmationGate(entry, scopeKey, confirmations), resources.artifacts),
    );
    const hasConfirmationTools = this.registeredTools.some((entry) => entry.requiresConfirmation);
    const appendSystemPrompt = () => (hasConfirmationTools ? `${MCP_ARTIFACT_GUIDANCE}\n${MCP_CONFIRMATION_GUIDANCE}` : MCP_ARTIFACT_GUIDANCE);
    return {
      name: "mcp-client",
      tools: channelTools,
      appendSystemPrompt,
      stop: () => {
        confirmations.clear();
        this.confirmationStores.delete(confirmations);
      },
    } satisfies AgentPlugin;
  }
  public async start(): Promise<void> {
    this.ctx.logger.info("初始化 MCP 客户端...");

    for (const [name, server] of Object.entries(this.config.mcpServers)) {
      if (server.enable === false) {
        this.ctx.logger.info(`MCP 服务器 ${name} 已禁用，跳过连接`);
        continue;
      }

      try {
        const { client, transport } = await connectMcpServer(this.ctx, name, server);
        this.transports.set(name, transport);
        this.clients.set(name, client);
        this.ctx.logger.success(`成功连接到 MCP 服务器 ${name}`);
      } catch (error) {
        this.ctx.logger.error(`连接到 MCP 服务器 ${name} 失败: ${(error as Error).message}`);
      }
    }

    const registry = new Map<string, { client: Client; tools: Record<string, McpToolEntry> }>();

    const publishAgentPlugin = () => {
      // A catalog change invalidates every pre-refresh confirmation. Keep old runtime snapshots fail-closed.
      for (const confirmations of this.confirmationStores) confirmations.clear();
      this.registeredTools = [...registry.values()]
        .flatMap(({ tools }) => Object.values(tools))
        .sort((left, right) => left.tool.name.localeCompare(right.tool.name));

      for (const entry of this.registeredTools) {
        this.logger.info(`注册工具 ${entry.tool.name}${entry.requiresConfirmation ? "（需要确认）" : ""}`);
      }

      this.disposeAgentPlugin?.();
      this.disposeAgentPlugin = this.ctx.yesimbot.agent.use(this);
    };

    const refreshServerTools = async (name: string, client: Client) => {
      const resp = await client.listTools();
      const tools = resp.tools;
      this.ctx.logger.info(`MCP 服务器 ${name} 提供的工具: ${tools.map((t) => t.name).join(", ")}`);

      const entries: Record<string, McpToolEntry> = {};
      const usedExposedNames = new Set<string>();
      for (const tool of tools) {
        const exposedName = uniqueToolName(safeToolName(`${name}-${tool.name}`), usedExposedNames);
        entries[tool.name] = {
          serverName: name,
          upstreamToolName: tool.name,
          requiresConfirmation: classifyToolRisk(tool.name, tool.description) === "side-effect",
          tool: {
            name: exposedName,
            description: tool.description,
            inputSchema: jsonSchema(tool.inputSchema),
            execute: async (params: unknown) => {
              try {
                const result = await client.callTool({ name: tool.name, arguments: structuredClone(params as Record<string, unknown>) });
                return result.content as Array<McpToolOutputBlock>;
              } catch (error) {
                this.ctx.logger.error(`调用工具 ${tool.name} 失败: ${(error as Error).message}`);
                throw error;
              }
            },
          } satisfies AgentTool,
        };
      }

      registry.set(name, { client, tools: entries });
    };

    this.ctx.logger.info("注册 MCP 客户端工具...");

    for (const [name, client] of this.clients.entries()) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        try {
          await refreshServerTools(name, client);
          publishAgentPlugin();
        } catch (error) {
          this.ctx.logger.error(`刷新 MCP 服务器 ${name} 工具失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      await refreshServerTools(name, client);
    }

    publishAgentPlugin();

    this.ctx.logger.success("MCP 客户端初始化完成");
  }

  public async stop(): Promise<void> {
    this.ctx.logger.info("清理 MCP 客户端...");
    this.disposeAgentPlugin?.();
    this.disposeAgentPlugin = undefined;
    for (const confirmations of this.confirmationStores) confirmations.clear();
    this.confirmationStores.clear();

    for (const [name, client] of this.clients.entries()) {
      try {
        await client.close();
        this.ctx.logger.success(`成功断开 MCP 服务器 ${name}`);
      } catch (error) {
        this.ctx.logger.error(`断开 MCP 服务器 ${name} 失败: ${(error as Error).message}`);
      }
    }

    for (const [name, transport] of this.transports.entries()) {
      try {
        await transport.close();
        this.ctx.logger.success(`成功关闭传输 ${name}`);
      } catch (error) {
        this.ctx.logger.error(`关闭传输 ${name} 失败: ${(error as Error).message}`);
      }
    }

    this.clients.clear();
    this.transports.clear();
    this.ctx.logger.success("MCP 客户端已清理");
  }

  /** Wraps side-effect tools with the pre-upstream confirmation gate; read-only tools stay untouched. */
  private withConfirmationGate(entry: McpToolEntry, scopeKey: string | undefined, confirmations: ConfirmationStore): AgentTool {
    if (!entry.requiresConfirmation) {
      return entry.tool;
    }

    return {
      ...entry.tool,
      execute: (input: unknown, options: AgentToolExecuteContext) => this.runConfirmationGate(entry, scopeKey, confirmations, input, options),
    };
  }

  private async runConfirmationGate(
    entry: McpToolEntry,
    scopeKey: string | undefined,
    confirmations: ConfirmationStore,
    input: unknown,
    options: AgentToolExecuteContext,
  ): Promise<Array<McpToolOutputBlock>> {
    if (scopeKey === undefined) {
      return confirmationUnavailableOutput(entry.tool.name, "scope-unavailable", "无法确定当前频道，确认状态不可绑定");
    }

    let argsHash: string;
    try {
      argsHash = hashArgs(input);
    } catch {
      return confirmationUnavailableOutput(entry.tool.name, "args-unhashable", "调用参数无法规范化，无法建立参数绑定");
    }

    const observation = inspectLatestConfirmationInput(options?.messages);
    const actorId = observation.latest?.actorId;
    const registrationBase = { channelKey: scopeKey, serverName: entry.serverName, upstreamToolName: entry.upstreamToolName, argsHash };
    const inputTrace = {
      argsHash: argsHash.slice(0, 12),
      actorId,
      currentMessageCount: options?.messages?.length ?? 0,
      currentCarrierCount: observation.carriers.length,
      currentCarriers: observation.carriers.slice(-8).map((carrier) => ({
        carrier: carrier.carrier,
        ...(carrier.platformMessageId ? { platformMessageId: carrier.platformMessageId } : {}),
        ...(carrier.agentMessageId ? { agentMessageId: carrier.agentMessageId } : {}),
        ...(carrier.actorId ? { actorId: carrier.actorId } : {}),
        codeState: carrier.codeState,
      })),
      latestCarrier: observation.latest?.carrier ?? "none",
      latestPlatformMessageId: observation.latest?.platformMessageId,
      latestAgentMessageId: observation.latest?.agentMessageId,
      confirmationState: observation.latest?.codeState ?? "absent",
    };

    // Do not create a parallel actorless pending entry when a previous request is already bound to a
    // concrete sender. That would rotate the displayed code while hiding the missing trusted carrier.
    if (actorId === undefined) {
      const actorBoundPending = confirmations.findByArgs(registrationBase).filter((pending) => pending.actorId !== undefined);
      if (actorBoundPending.length > 0) {
        const bindingHash = hashArgs({ ...registrationBase, actorId: null }).slice(0, 16);
        this.logger.debug("mcp.confirmation.blocked", {
          bindingHash,
          ...inputTrace,
          pendingActorIds: actorBoundPending.flatMap((pending) => (pending.actorId ? [pending.actorId] : [])),
          reason: "trusted-actor-unavailable",
        });
        return confirmationUnavailableOutput(entry.tool.name, "trusted-actor-unavailable", "当前消息没有可信发送者身份，无法消费已绑定到具体发送者的确认");
      }
    }

    const registration = { ...registrationBase, actorId };
    const pending = confirmations.register(registration);
    const provided = observation.code;
    const bindingHash = hashArgs({
      channelKey: scopeKey,
      serverName: entry.serverName,
      upstreamToolName: entry.upstreamToolName,
      actorId: actorId ?? null,
      argsHash,
    }).slice(0, 16);
    const trace = {
      bindingHash,
      ...inputTrace,
      pendingActorId: pending.actorId,
      codeMatches: provided !== undefined && provided === pending.code,
    };
    this.logger.debug("mcp.confirmation.binding", trace);

    if (provided === undefined || provided !== pending.code) {
      const reason = provided === undefined ? "awaiting-confirmation" : "short-code-mismatch";
      this.logger.debug("mcp.confirmation.blocked", { ...trace, reason });
      return confirmationRequiredOutput(entry, pending, Date.now(), reason);
    }

    // Consume before the upstream call: a failure, retry, or duplicate must never reuse the same code.
    const consumed = confirmations.consume(pendingKey(scopeKey, entry.serverName, entry.upstreamToolName, actorId));
    const consumedMatches = consumed !== undefined && consumed.code === provided;
    this.logger.debug("mcp.confirmation.consume", { ...trace, consumed: consumedMatches });
    if (!consumedMatches) {
      this.logger.debug(`MCP 工具 ${entry.tool.name} 的确认已失效，已阻止本次上游调用`);
      return confirmationRequiredOutput(entry, pending, Date.now(), "stale-pending");
    }

    this.logger.info(`MCP 工具 ${entry.tool.name} 已获得一次性确认，允许本次上游调用`);
    const output = await entry.tool.execute(input, options);
    return (output ?? []) as Array<McpToolOutputBlock>;
  }
}

function confirmationRequiredOutput(
  entry: McpToolEntry,
  pending: PendingConfirmation,
  now: number,
  reason: ConfirmationBlockReason,
): Array<McpToolOutputBlock> {
  const remainingMs = Math.max(0, pending.expiresAt - now);
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const lines = [
    "confirmation_required",
    `工具 ${entry.tool.name}（MCP server: ${entry.serverName}）可能产生外部副作用，本次调用没有执行，上游未被请求。`,
    `reason: ${reason}`,
    `参数指纹: ${pending.argsHash.slice(0, 12)}`,
    `确认短码: ${pending.code}（${minutes} 分钟内有效，仅可使用一次）`,
    `请让用户在同一频道回复精确的「确认 ${pending.code}」；若该确认已绑定发送者，后续消息必须保留可信原始身份并由同一发送者确认，身份丢失时不会执行。`,
    "在收到有效确认前，不得声称已下单、已支付、已取消或已完成。",
  ];
  return [{ type: "text", text: lines.join("\n").slice(0, MCP_MAX_OUTPUT_CHARS) }];
}

function confirmationUnavailableOutput(toolName: string, reason: ConfirmationBlockReason, detail: string): Array<McpToolOutputBlock> {
  const lines = [
    "confirmation_unavailable",
    `工具 ${toolName} 无法建立确认绑定（reason: ${reason}）：${detail}。`,
    "本次调用没有执行，上游未被请求；不要重复尝试该调用。",
  ];
  return [{ type: "text", text: lines.join("\n").slice(0, MCP_MAX_OUTPUT_CHARS) }];
}

function safeToolName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
  return normalized || "mcp";
}

function uniqueToolName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) {
    suffix += 1;
  }

  const unique = `${base}_${suffix}`;
  used.add(unique);
  return unique;
}

function wrapToolWithArtifacts(tool: AgentTool, artifacts: ArtifactStore): AgentTool {
  const writer = artifacts.forTool(tool.name);
  return {
    ...tool,
    toModelOutput: async (options) => {
      const { output } = options as { output: Array<McpToolOutputBlock> };
      if (!output || output.length === 0) {
        return { type: "text" as const, value: "" };
      }

      const lines: string[] = [];
      let imageCount = 0;
      let imageBytes = 0;
      for (const block of output) {
        if (!block || typeof block !== "object") {
          lines.push("[不支持的内容块：unknown]");
          continue;
        }
        if (block.type === "text") {
          lines.push(block.text ?? "");
          continue;
        }

        const mediaType = typeof block.mimeType === "string" ? block.mimeType.toLowerCase() : undefined;
        if (block.type === "image" && typeof block.data === "string" && mediaType !== undefined && SUPPORTED_IMAGE_MIMES[mediaType]) {
          const bytes = decodeInlineImage(block.data);
          if (!bytes) {
            lines.push("[图片资源：数据无效或大小超出限制]");
            continue;
          }
          if (imageCount >= MCP_IMAGE_MAX_COUNT || imageBytes + bytes.byteLength > MCP_IMAGE_MAX_TOTAL_BYTES) {
            lines.push("[图片资源：超出图片限制]");
            continue;
          }
          try {
            const uri = await writer.put(bytes, { mediaType, filename: "mcp-image" });
            imageCount += 1;
            imageBytes += bytes.byteLength;
            lines.push(`[图片：${uri}（${mediaType}，${formatBytes(bytes.byteLength)}）]`);
          } catch {
            lines.push("[图片资源：持久化失败]");
          }
          continue;
        }
        // Unknown or unsupported blocks become bounded descriptions, never opaque JSON.
        lines.push(`[不支持的内容块：${describeBlockType(block.type)}]`);
      }

      const value = lines.join("\n").trim().slice(0, MCP_MAX_OUTPUT_CHARS);
      return { type: "text" as const, value };
    },
  };
}

function decodeInlineImage(data: string): Uint8Array | null {
  if (data.length === 0 || data.length > Math.ceil(MCP_IMAGE_MAX_BYTES / 3) * 4) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) return null;
  const bytes = Buffer.from(data, "base64");
  return bytes.byteLength > 0 && bytes.byteLength <= MCP_IMAGE_MAX_BYTES ? bytes : null;
}

function describeBlockType(type: string): string {
  return type.length > MCP_MAX_BLOCK_TYPE_CHARS ? `${type.slice(0, MCP_MAX_BLOCK_TYPE_CHARS)}…` : type;
}

function formatBytes(length: number): string {
  if (length >= 1024 * 1024) return `${(length / (1024 * 1024)).toFixed(1)} MiB`;
  if (length >= 1024) return `${(length / 1024).toFixed(1)} KiB`;
  return `${length} B`;
}
