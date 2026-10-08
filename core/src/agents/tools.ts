import { EphemeralImageProjectionStore, jsonSchema, type AgentMessage, type AgentTool } from "@yesimbot/agent-runtime";
import type { LanguageModel } from "ai";
import { h, type Bot, type Element } from "koishi";

import type { PacingConfig } from "../config.js";
import { ContextSourceError } from "../conversations/context-blocks.js";
import type { CompartmentExpansionRecord, Conversation } from "../conversations/index.js";
import { parseReply } from "../messages/index.js";
import { detectImageMediaType, prepareOutputSegments, ResourceReadError, type ChannelResources } from "../resources/index.js";
import { ContextBudgetError } from "../runtimes/context-budget.js";
import type { ContextWorkspace, ContextBlocksInput, ContextLoadInput } from "../runtimes/context-workspace.js";
import { describeImageBytes } from "./image-preview.js";
import { buildPolisherTurnContext, validatePolishedMessages, type PolisherTurnContext } from "./polisher.js";

const READ_MAX_TEXT_CHARS = 30_000;
const ONEBOT_GROUP_CHANNEL_PREFIX = "group:";

type ResourceReadInput = { uri: string };

export type ReadImageMode = "native" | "vision" | "unavailable";

export interface ReadImagePolicy {
  readonly mode: ReadImageMode;
  readonly visionModel?: LanguageModel;
}

export type ResourceReadResult = {
  uri: string;
  filename?: string;
  mediaType?: string;
  text?: string;
  imageMode?: ReadImageMode;
  error?: string;
};

type DescribeImageInput = { uri: string; question: string };

type DescribeImageOutput = { text: string } | { error: string };

type SendMessageMode = "element" | "raw";

type SendMessageInput = {
  messages: string[];
  facts?: string[];
  channel?: string;
  mode?: SendMessageMode;
  continue?: boolean;
  inner_thought?: string;
};

type SendMessageOutput =
  | { ok: true; messageIds: string[]; count: number }
  | { ok: false; error: { name: string; message: string }; sent: string[]; failedAt: number };

/** Facts about one delivered platform message, reported so the owner can announce it. */
export interface DeliveredNotice {
  readonly channelId: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly text: string;
}

/** Facts about an aborted send. The model learns from the tool result; this is for operators. */
export interface SendFailedNotice {
  readonly channelId: string;
  readonly turnId: string;
  readonly failedAt: number;
  readonly total: number;
  readonly error: { readonly name: string; readonly message: string };
}

export interface SendMessageToolOptions {
  readonly bot: Bot;
  /** Channel used when the model omits `channel`. */
  readonly channelId: string;
  readonly resources: ChannelResources;
  readonly pacing: PacingConfig;
  /** Exposes the `inner_thought` field so monologue never has to be written as visible text. */
  readonly innerThought: boolean;
  /** Requires the explicit `facts` field when a send-message polisher owns style rendering. */
  readonly factsRequired?: boolean;
  /** Optional pre-send rewrite. A result replaces `messages` only; failures keep the original draft. */
  readonly polish?: (input: {
    readonly facts: readonly string[];
    readonly messages: readonly string[];
    readonly turnContext: PolisherTurnContext;
    readonly signal?: AbortSignal;
  }) => Promise<readonly string[] | undefined>;
  readonly onDelivered?: (notice: DeliveredNotice) => void;
  readonly onFailed?: (notice: SendFailedNotice) => void;
}

/**
 * Sends the supplied messages to a platform. Plain model text is never delivered; plugin-owned
 * delivery tools can send their own content. Ends the turn unless the model asks to `continue`.
 */
export function createSendMessageTool(options: SendMessageToolOptions): AgentTool<SendMessageInput, SendMessageOutput> {
  const { bot, channelId: defaultChannelId, resources, pacing, innerThought, factsRequired, polish, onDelivered, onFailed } = options;
  return {
    name: "send_message",
    terminal: (input) => !input.continue,
    description: sendMessageDescription(innerThought, factsRequired === true),
    inputSchema: jsonSchema<SendMessageInput>({
      type: "object",
      properties: {
        messages: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
          description: factsRequired
            ? "本轮待发送的草稿消息；完整表达事实、判断和交流动作，不自行添加事实或承诺。每一项对应一条独立消息，润色时保留条数与顺序"
            : "要发送的消息，每一项作为一条独立消息按顺序发出；精确文本使用 raw 或 <text>，保留事实、代码、链接和消息元素",
        },
        ...(factsRequired
          ? {
              facts: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
                description: "本次回复依据的明示事实列表：哪一条来自可见消息、哪一条来自工具结果、哪一条只是你的推断；只用于发送前校验，不会发送给任何人",
              },
            }
          : {}),
        channel: {
          type: "string",
          minLength: 1,
          description: "目标频道 ID；留空则发往当前频道。OneBot 群频道直接填写裸群号，不要使用 group: 前缀",
        },
        mode: { type: "string", enum: ["element", "raw"], description: "element（默认）解析消息元素；raw 原样发送纯文本" },
        continue: {
          type: "boolean",
          description: "默认 false，发送后结束本轮；true 时继续下一步。本轮还要调用其他工具或发送更多内容时，必须在这次发送前设为 true",
        },
        ...(innerThought
          ? {
              inner_thought: {
                type: "string",
                description: factsRequired
                  ? "本次发送前的内心独白；只保留在你自己的历史里，不会发送给任何人"
                  : "本回合简短行为判断：互动对象、可见事实与推测、是否回应和行动计划；不写角色台词或对外文本，不会发送给任何人",
              },
            }
          : {}),
      },
      required: factsRequired ? ["facts", "messages"] : ["messages"],
    }),
    execute: async (input, execution) => {
      const requestedTarget = input.channel ? input.channel : defaultChannelId;
      const target =
        bot.platform === "onebot" && requestedTarget.startsWith(ONEBOT_GROUP_CHANNEL_PREFIX)
          ? requestedTarget.slice(ONEBOT_GROUP_CHANNEL_PREFIX.length)
          : requestedTarget;
      const inputMessages = Array.isArray(input.messages) ? input.messages : [];
      if (inputMessages.length === 0) return { ok: false, error: { name: "InvalidInput", message: "messages is empty" }, sent: [], failedAt: 0 };
      if (inputMessages.some((message) => typeof message !== "string" || message.length === 0))
        return { ok: false, error: { name: "InvalidInput", message: "messages must be non-empty strings" }, sent: [], failedAt: 0 };
      if (input.mode && input.mode !== "element" && input.mode !== "raw")
        return { ok: false, error: { name: "InvalidInput", message: `mode must be "element" or "raw"` }, sent: [], failedAt: 0 };
      const mode = input.mode ?? "element";
      const messages = await polishedMessages(polish, input, execution.messages, execution.abortSignal);
      const total = messages.length;
      const sent: string[] = [];
      let elapsed = 0;
      const abort = (index: number, error: { name: string; message: string }): SendMessageOutput => {
        onFailed?.({ channelId: target, turnId: execution.turnId, failedAt: index, total, error });
        return { ok: false, error, sent, failedAt: index };
      };
      for (const [index, message] of messages.entries()) {
        try {
          const segments = mode === "raw" ? [[h.text(message)]] : await prepareOutputSegments(parseReply(message), resources, execution.abortSignal);
          for (const segment of segments) {
            if (sent.length > 0) {
              const delay = pacedDelay(segment, pacing, elapsed);
              const startedAt = Date.now();
              await sleep(delay, execution.abortSignal);
              elapsed += Math.max(delay, Date.now() - startedAt);
            }
            if (execution.abortSignal?.aborted) return abort(index, { name: "AbortError", message: "send_message aborted" });
            const ids = await bot.sendMessage(target, segment);
            sent.push(...ids);
            for (const id of ids) onDelivered?.({ channelId: target, messageId: id, turnId: execution.turnId, text: message });
          }
        } catch (cause) {
          if (cause instanceof ResourceReadError) return abort(index, { name: cause.code, message: cause.message });
          return abort(index, {
            name: cause instanceof Error ? cause.name : "Error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      return { ok: true, messageIds: sent, count: total };
    },
  };
}

export function createReadTool(
  resources: ChannelResources,
  policyInput: ReadImagePolicy | boolean,
  imageProjection = new EphemeralImageProjectionStore(),
): AgentTool<{ uri: string }, ResourceReadResult> {
  const policy: ReadImagePolicy = typeof policyInput === "boolean" ? { mode: policyInput && resources.imageInput ? "native" : "unavailable" } : policyInput;
  const lines = [
    "读取资源内容。仅在确实需要内容时读取精确 URI，不要猜测或拼造 URI。",
    "URI 形如 scheme://authority[/path]，不能包含 ?、#、%，也不能有 . 或 .. 路径段。",
    "- asset://<32位十六进制id>：平台输入的不可变资源，包括图片与文本文件。消息里看到的 [图片：asset://xxx] 和 [文件：名字 asset://xxx] 就是它；路径部分必须为空。",
    "- artifact://<tool>/<uuid>：工具输出的不可变工件，uuid 由工具返回，原样传入。",
  ];
  for (const reader of resources
    .listReaders()
    .slice()
    .sort((a, b) => a.scheme.localeCompare(b.scheme))) {
    lines.push(`- ${reader.scheme}://：${reader.prompt}`);
  }
  lines.push("", "返回 {uri, filename?, mediaType?, text?, imageMode?, error?}。", "- 文本资源在 text 中直接给出内容，过长会被截断并以 [内容已截断] 结尾。");
  if (policy.mode === "native") {
    lines.push("- 图片资源：读取后图片字节将随结果返回，你可以直接查看图片内容。查看图片必须使用本工具读取。");
  } else if (policy.mode === "vision") {
    lines.push("- 图片资源：本工具会自动调用视觉模型，并在 text 中返回图片描述；主模型不会接收原始图片字节。");
  } else {
    lines.push("- 图片资源只返回明确的不可用结果，当前无法查看图片内容；不要根据文件名或上下文猜测画面。");
  }
  lines.push(
    "- 其他二进制只给出类型与大小，无法查看内容。",
    "- error 可能为：invalid_resource_uri、resource_not_found、resource_unavailable、resource_too_large、timeout、resource_read_aborted、resource_read_failed、invalid_image_data、vision_call_failed 或 image_input_unavailable。",
  );

  return {
    name: "read",
    description: lines.join("\n"),
    inputSchema: jsonSchema<ResourceReadInput>({ type: "object", properties: { uri: { type: "string", description: "要读取的资源 URI" } }, required: ["uri"] }),
    execute: async ({ uri }, execution) => {
      // A retried/reused tool call ID must never inherit bytes from an earlier read.
      imageProjection.clear(execution.toolCallId);
      let opened: Awaited<ReturnType<ChannelResources["openStrict"]>>;
      try {
        opened = await resources.openStrict(uri, execution.abortSignal);
      } catch (cause) {
        if (cause instanceof ResourceReadError) return { uri, error: cause.code };
        return { uri, error: "resource_read_failed" };
      }

      const detectedImageType = detectImageMediaType(opened.bytes);
      const declaredImage = opened.mediaType?.startsWith("image/") ?? false;
      if (declaredImage && !detectedImageType) {
        return {
          uri,
          filename: opened.filename,
          mediaType: opened.mediaType,
          imageMode: "unavailable",
          error: "invalid_image_data",
          text: "模型没有看到图片内容。",
        };
      }

      const mediaType = detectedImageType ?? opened.mediaType;
      if (!detectedImageType) return { uri, filename: opened.filename, mediaType, text: describeBytes(opened.bytes, mediaType) };

      const metadata = describeBytes(opened.bytes, detectedImageType);
      if (policy.mode === "native" && resources.imageInput) {
        if (execution.abortSignal?.aborted) {
          return {
            uri,
            filename: opened.filename,
            mediaType: detectedImageType,
            imageMode: "unavailable",
            error: "resource_read_aborted",
            text: "模型没有看到图片内容。",
          };
        }
        imageProjection.stage({
          toolCallId: execution.toolCallId,
          turnId: execution.turnId,
          bytes: opened.bytes,
          mediaType: detectedImageType,
          signal: execution.abortSignal,
        });
        return { uri, filename: opened.filename, mediaType: detectedImageType, text: metadata, imageMode: "native" };
      }

      if (policy.mode === "vision" && policy.visionModel) {
        try {
          const text = await describeImageBytes({
            model: policy.visionModel,
            bytes: opened.bytes,
            mediaType: detectedImageType,
            question: "请描述这张图片中清晰可见的内容，并说明无法确认的部分。",
            abortSignal: execution.abortSignal,
          });
          return { uri, filename: opened.filename, mediaType: detectedImageType, text, imageMode: "vision" };
        } catch {
          return {
            uri,
            filename: opened.filename,
            mediaType: detectedImageType,
            imageMode: "unavailable",
            error: execution.abortSignal?.aborted ? "resource_read_aborted" : "vision_call_failed",
            text: "模型没有看到图片内容。",
          };
        }
      }

      return {
        uri,
        filename: opened.filename,
        mediaType: detectedImageType,
        imageMode: "unavailable",
        error: "image_input_unavailable",
        text: "模型没有看到图片内容。",
      };
    },
    toModelOutput: ({ toolCallId, output }) => {
      const image = imageProjection.get(toolCallId);
      if (!image) return { type: "json", value: output };
      // AI SDK may project the same live tool result more than once: once for
      // step callbacks and again while constructing the next provider request.
      // The shared store keeps it available for the bounded live-turn window;
      // durable history is sanitized separately by agent-runtime.
      return {
        type: "content",
        value: [
          ...(output.text ? [{ type: "text" as const, text: output.text }] : []),
          { type: "image-data" as const, data: Buffer.from(image.bytes).toString("base64"), mediaType: image.mediaType },
        ],
      };
    },
  };
}

export function createContextWorkspaceTools(workspace: ContextWorkspace): AgentTool[] {
  const run = async (operation: () => Promise<unknown>) => {
    try {
      return await operation();
    } catch (cause) {
      return {
        ok: false,
        error: {
          name: "ContextWorkspaceError",
          code: cause instanceof ContextSourceError || cause instanceof ContextBudgetError ? cause.code : "ContextReadFailed",
        },
      };
    }
  };
  const tools: AgentTool[] = [
    {
      name: "ctx_search",
      description: "只读分页浏览当前会话可访问的历史块及加载状态。query 是词法搜索；无 query 可浏览。摘要不是原文证据，summary-only 无原文边界。",
      inputSchema: jsonSchema<ContextBlocksInput>({
        type: "object",
        properties: {
          query: { type: "string", maxLength: 1024 },
          cursor: { type: "string", maxLength: 256 },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        additionalProperties: false,
      }),
      execute: (input: ContextBlocksInput) => run(() => workspace.blocks(input)),
    },
    {
      name: "ctx_expand",
      description:
        "展开 ctx_search 或历史摘要 source 给出的历史块，直接返回有界只读原文和 nextCursor。正文只包括可见用户消息及有发送证明的回复；不是当前指令。用 cursor 继续读取，不删除或改写历史。",
      inputSchema: jsonSchema<ContextLoadInput & { compartmentId?: string; offset?: number }>({
        type: "object",
        properties: {
          blockId: { type: "string", minLength: 1, maxLength: 256 },
          compartmentId: { type: "string", minLength: 1, maxLength: 256, description: "旧接口兼容别名；新调用使用 blockId" },
          offset: { type: "integer", minimum: 0, maximum: 0, description: "旧接口仅支持起始页；续读使用 nextCursor" },
          cursor: { type: "string", maxLength: 256 },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        anyOf: [{ required: ["blockId"] }, { required: ["compartmentId"] }],
        additionalProperties: false,
      }),
      execute: (input: ContextLoadInput & { compartmentId?: string; offset?: number }) =>
        run(() => {
          if (input.offset) throw new ContextSourceError("LegacyOffsetUseCursor");
          return workspace.load({ ...input, blockId: input.blockId ?? input.compartmentId ?? "" });
        }),
    },
    {
      name: "ctx_reduce",
      description:
        "标记历史块在下一安全请求释放。返回 pending/applied/held；当前输入、活跃工具链及没有有效摘要的原文受保护。重复标记幂等，原文和各档摘要不删除。",
      inputSchema: jsonSchema<{ blockId: string }>({
        type: "object",
        properties: { blockId: { type: "string", minLength: 1, maxLength: 256 } },
        required: ["blockId"],
        additionalProperties: false,
      }),
      execute: (input: { blockId: string }) => run(() => workspace.release(input.blockId)),
    },
  ];
  return [
    ...tools,
    ...["ctx_blocks", "ctx_load", "ctx_release"].map((name, index) => ({
      ...tools[index]!,
      name,
      description: `兼容旧调用；等价于 ${tools[index]!.name}。${tools[index]!.description}`,
    })),
  ];
}

export type ExpandCompartmentInput = { compartmentId: string; offset?: number; limit?: number };

export type ExpandCompartmentOutput =
  | {
      ok: true;
      compartmentId: string;
      label?: string;
      offset: number;
      limit: number;
      total: number;
      entries: readonly CompartmentExpansionRecord[];
      nextOffset?: number;
    }
  | { ok: false; error: { name: string; message: string } };

/** Read-only access to the current channel's raw source records behind one compartment summary. */
export function createExpandCompartmentTool(conversation: Conversation): AgentTool<ExpandCompartmentInput, ExpandCompartmentOutput> {
  return {
    name: "ctx_expand",
    description:
      "只读展开当前频道会话中的一个历史 compartment。只能使用压缩历史中明确给出的 compartmentId；按 offset/limit 分页读取原始对话，不调用模型、不修改会话。未知 ID、跨频道 ID 或没有原始边界时返回错误。",
    inputSchema: jsonSchema<ExpandCompartmentInput>({
      type: "object",
      properties: {
        compartmentId: { type: "string", minLength: 1, description: "压缩历史中显示的 compartmentId" },
        offset: { type: "integer", minimum: 0, description: "分页偏移，默认 0" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "每页最多 50 条原始记录，默认 50" },
      },
      required: ["compartmentId"],
      additionalProperties: false,
    }),
    execute: async (input) => {
      try {
        const result = await conversation.expandCompartment(input.compartmentId, { offset: input.offset, limit: input.limit });
        return { ok: true as const, ...result };
      } catch (cause) {
        return {
          ok: false as const,
          error: { name: "CompartmentExpansionError", message: cause instanceof Error ? cause.message : String(cause) },
        };
      }
    },
  };
}

export function createDescribeImageTool(model: LanguageModel, resources: ChannelResources): AgentTool<DescribeImageInput, DescribeImageOutput> {
  return {
    name: "describe_image",
    description:
      "当你需要了解图片内容、但当前无法直接查看图片时，使用本工具调用外部视觉模型生成图片描述。uri 必须是 asset://<32位十六进制id>。返回 {text} 或 {error}：invalid_uri 表示 URI 形状不合法；asset_not_found 表示资源不存在；not_an_image 表示该资源不是已知格式的图片；vision_call_failed 表示外部模型调用失败，可重试一次。",
    inputSchema: jsonSchema<DescribeImageInput>({
      type: "object",
      properties: {
        uri: { type: "string", description: "要描述的图片资源 URI，形如 asset://<32位十六进制id>" },
        question: { type: "string", description: "要从图片中获取的信息" },
      },
      required: ["uri", "question"],
    }),
    execute: async ({ uri, question }, execution) => {
      if (!/^asset:\/\/[a-f0-9]{32}$/.test(uri)) return { error: "invalid_uri" };
      const id = uri.slice("asset://".length);
      let bytes: Uint8Array;
      try {
        bytes = await resources.assets.get(id);
      } catch {
        return { error: "asset_not_found" };
      }
      const mediaType = detectImageMediaType(bytes);
      if (!mediaType) return { error: "not_an_image" };
      try {
        return {
          text: await describeImageBytes({ model, bytes, mediaType, question, abortSignal: execution.abortSignal }),
        };
      } catch (cause) {
        return { error: `vision_call_failed: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
    },
  };
}

function sendMessageDescription(innerThought: boolean, factsRequired: boolean): string {
  return `向频道发送文字或消息元素。你的普通文本输出不会被发送；调用本工具才能发送 messages 中的内容。其他实际提供的发送工具可以发送它们各自支持的内容。

${factsRequired ? "调用后生成真正展示给用户的消息，可以针对某个用户或所有用户回复；只写在普通文本输出里的内容不会被送达。\n\n" : ""}# 参数

## messages
要发送的消息列表，每一项作为一条独立消息按顺序发出。
由你在提交草稿时按语义和聊天节奏决定分条：独立的回应、转折、补充适合放入不同项目；短而完整的回复可以只发一条。不要把所有内容挤进同一条，也不要按字数、句号或空行机械拆分。
完整代码、命令、引用及其必要上下文不要拆散；除此之外，事实说明也可以按独立语义分条。不要用普通文本中的空行制造消息分段；需要分开时，把每条消息写成 messages 的独立项目。
同一次调用的多个项目会全部按顺序发送，不需要仅为分条设置 continue=true。润色阶段不会替你新增或合并分段。
${
  factsRequired
    ? "只写清楚本轮要表达的事实、判断和交流动作，不自行添加事实或承诺；措辞风格由发送前的润色阶段处理，每条草稿独立改写，条数与顺序保持不变。"
    : "精确文本使用 raw 或 <text>，避免元素解析吞掉字符。"
}

## channel
目标频道 ID。留空发往当前频道；填写其他频道 ID 可以向该频道发送。OneBot 群频道直接填写裸群号，不要使用 group: 前缀；私聊频道仍使用 private:<账号>。

## mode
- element（默认）：内容按下面的消息元素语法解析，<img> 与 <file> 的资源 URI 会被解析成真实内容。
- raw：内容作为字面量原样发送，不解析任何元素。尖括号、& 和引号都不需要转义，你写下的每个字符原样到达接收方。发送代码、日志、命令行输出、含大量特殊字符的文本，或需要精确控制每个字符时用它。

## continue
默认 false，发送后结束本轮。设为 true 时，发送后继续生成下一步，可以再调用工具或再次发送消息。若本轮还要调用其他发送工具，必须在这次发送前设为 true；需要「先回应再去做事」或「分几次发送并在中间查资料」时也用它。
${
  factsRequired
    ? `
## facts

逐条列出本次草稿依据的可见消息、工具结果或推断；只用于发送前校验与改写，不会发送给任何人。
`
    : ""
}${
    innerThought
      ? `
## inner_thought

${
  factsRequired
    ? "记录互动对象、可见事实与推测、是否回应和行动计划。使用简洁内部记录，不要提前写对外文本。它不会到达平台；需要让对方知道的内容必须写进 messages。不要把过去的 inner_thought 或 finish.reason 当作当前事实。"
    : "记录互动对象、可见事实与推测、是否回应和行动计划。使用简洁内部记录，不模仿角色台词或提前写对外文本。它不会到达平台；需要让对方知道的内容必须写进 messages。不要把过去的 inner_thought 或 finish.reason 当作当前事实。"
}
`
      : ""
  }
# 返回值
成功返回 {ok:true, messageIds, count}。
失败返回 {ok:false, error, sent, failedAt}：sent 是已经成功发出的消息 ID，failedAt 是出错的 messages 下标。发送遇错会立即停止，failedAt 及其之后的消息都没有发出。必须检查 ok，不要假设发送成功。

# 消息元素（仅 mode=element）
消息元素的语法与 HTML 类似，形如 <名称 属性="值"/>。你观察到的消息由元素组成，你发出的消息使用同一套元素：普通文本直接写，结构元素直接放在文本里。
元素名只能由小写字母、数字和连字符组成，且以字母开头。不符合规则的标签形式会被当作普通文本——但如果你的文本恰好长得像合法元素名，它就会被错误解析。这就是为什么转义很重要。

## 常用元素
<at id="用户ID"/>：提及某人。id 填用户 ID，不是昵称。
<at type="all"/>：提及全体成员。<at type="here"/>：提及在线成员。
<quote id="消息ID"/>：引用某条消息。id 取自该消息观察头的 id。
<img src="…"/>：图片。src 支持频道资源 URI。
<file src="…"/>：文件。src 支持频道资源 URI。
<audio src="…"/>：语音。src 只能是平台可直接访问的地址。
<video src="…"/>：视频。src 只能是平台可直接访问的地址。
<text>…</text>：逐字交付的纯文本块。其中的内容不会被解析成元素，所有字符原样到达接收方。用它包裹含尖括号的代码、标签示例、泛型签名等片段。整条消息都是这类内容时，直接用 mode=raw 更省事。

## 转义（关键）
< 和 > 如果没有转义，系统会尝试把它们之间的内容解析为元素。如果解析成功，你原本想输出的文字就会消失——这不是显示异常，而是内容被永久吞掉。
例如：你想说「当 a<b 且 c>d 时」，但 <b 且 c> 看起来像一个元素，会被解析掉，接收方看到的是「当 a d 时」。
规则：文本中出现的 <、>、&、" 如果不是用来构成元素标签，必须转义。
| 字符 | 转义 | 何时需要 |
|:---:|:---:|:---|
| < | &lt; | 文本中所有非元素用途的 < |
| > | &gt; | 文本中所有非元素用途的 > |
| & | &amp; | 文本中的 &（否则会被当作转义序列开头） |
| " | &quot; | 元素属性值内的引号 |

## 简短示例
- 普通文本：messages: ["今天天气不错"]
- 需要精确保留尖括号、代码或日志时使用 mode: "raw"。
- 引用和提及使用 <quote id="消息ID"/>、<at id="用户ID"/>；非元素用途的 <、>、&、" 必须转义。

## 资源与格式
只有 <img> 和 <file> 的 src 支持频道资源 URI；<audio>、<video> 只能使用平台可直接访问的地址。资源引用前先确认 URI 存在，解析失败的资源元素会被丢弃，其余消息仍继续发送；平台不支持的修饰元素不要作为结构依赖。`;
}

/** A polish failure or rejection never blocks delivery: the original draft is sent once. */
async function polishedMessages(
  polish: SendMessageToolOptions["polish"],
  input: SendMessageInput,
  currentTurnMessages: readonly AgentMessage[],
  signal: AbortSignal | undefined,
): Promise<readonly string[]> {
  if (!polish) return input.messages;
  try {
    const turnContext = buildPolisherTurnContext(currentTurnMessages);
    return (
      validatePolishedMessages(input.messages, await polish({ facts: input.facts ?? [], messages: input.messages, turnContext, signal })) ?? input.messages
    );
  } catch {
    return input.messages;
  }
}

function pacedDelay(segment: readonly Element[], pacing: PacingConfig, elapsed: number): number {
  const characters = segment.reduce((total, element) => total + elementTextLength(element), 0);
  const delay = Math.min(Math.max(250, Math.ceil((characters / pacing.charactersPerSecond) * 1000)), 10_000);
  return elapsed + delay >= pacing.maxTotalDelayMs ? 250 : Math.round(delay);
}

function elementTextLength(element: Element): number {
  return (
    (typeof element.attrs.content === "string" ? element.attrs.content.length : 0) +
    element.children.reduce((total, child) => total + elementTextLength(child), 0)
  );
}

function sleep(timeout: number, signal?: AbortSignal): Promise<void> {
  if (timeout <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeout);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function describeBytes(bytes: Uint8Array, mediaType?: string): string {
  const image = detectImageMediaType(bytes);
  if (image) return `[图片资源，${image}，${formatBytes(bytes.byteLength)}]`;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length <= READ_MAX_TEXT_CHARS) return text;
    const marker = "\n[内容已截断]";
    return `${text.slice(0, READ_MAX_TEXT_CHARS - marker.length)}${marker}`;
  } catch {
    return `[资源，${mediaType ?? "未知类型"}，${formatBytes(bytes.byteLength)}]`;
  }
}

function formatBytes(length: number): string {
  if (length >= 1024 * 1024) return `${(length / (1024 * 1024)).toFixed(1)} MiB`;
  if (length >= 1024) return `${(length / 1024).toFixed(1)} KiB`;
  return `${length} B`;
}

export function createFinishTool(): AgentTool<Record<string, never>, { ok: true }> {
  return {
    name: "finish",
    terminal: true,
    description:
      "结束本轮，不发送任何消息。当你判断当前场景不需要你参与、或已经做完该做的事且没有要说的话时使用。保持沉默是一个完整的选择，不需要为了确认收到或维持礼貌而发言。",
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
    }),
    execute: async () => ({ ok: true }),
  };
}
