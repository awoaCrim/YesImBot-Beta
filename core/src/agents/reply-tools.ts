import { jsonSchema, type AgentTool, type AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import type { Bot } from "koishi";

import type { PacingConfig } from "../config.js";
import type { ReplyJournalWriter } from "../conversations/reply-journal.js";
import type { ChannelResources } from "../resources/index.js";
import {
  ReplyCoordinator,
  replyPreflightFailure,
  type ReplyDeliveryNotice,
  type ReplyPart,
  type ReplySendFailureNotice,
  type ReplyStickerProvider,
} from "./reply.js";

export interface ReplyToolsOptions {
  readonly bot: Bot;
  readonly channelId: string;
  readonly resources: ChannelResources;
  readonly pacing: PacingConfig;
  readonly journal: ReplyJournalWriter;
  readonly innerThought: boolean;
  readonly sticker?: ReplyStickerProvider;
  readonly onDelivered?: (notice: ReplyDeliveryNotice) => void;
  readonly onFailed?: (notice: ReplySendFailureNotice) => void;
  readonly onWarn?: (reason: string, detail: Record<string, unknown>) => void;
  readonly stillAllowed?: () => boolean;
}

export interface ReplyToolSet {
  readonly tools: AgentTool[];
  readonly coordinator: ReplyCoordinator;
  readonly invalidate: () => void;
  readonly finishTurn: (turnId: string) => Promise<void>;
  setTurnAllowed: (check: (turnId: string) => boolean) => void;
}

/**
 * One authored sender per runtime. The main model decides the complete ordered reply and submits it
 * as `parts`; Core owns preflight, delivery proof, FIFO and platform transport.
 */
export function createReplyTools(options: ReplyToolsOptions): ReplyToolSet {
  const coordinator = new ReplyCoordinator(options);
  let turnAllowed: (turnId: string) => boolean = () => true;
  let retired = false;
  const finishedTurns = new Set<string>();
  const allowed = (turnId: string): boolean => {
    try {
      return !retired && !finishedTurns.has(turnId) && turnAllowed(turnId) && (options.stillAllowed?.() ?? true);
    } catch {
      return false;
    }
  };
  const tools = [authoredSendTool(options, coordinator, allowed)];
  return {
    tools,
    coordinator,
    invalidate: () => {
      retired = true;
      coordinator.close();
    },
    finishTurn: async (turnId) => {
      finishedTurns.add(turnId);
      if (finishedTurns.size > 64) finishedTurns.delete(finishedTurns.values().next().value!);
      coordinator.abortTurn(turnId);
      await coordinator.settle();
    },
    setTurnAllowed: (check) => {
      turnAllowed = check;
    },
  };
}

export function authoredDescription(innerThought: boolean, stickerAvailable: boolean): string {
  return `用 parts 提交本次完整的有序回复；普通文本输出不会发送。每个 {kind:"text",text:"..."} 是一个有意义的交流单元。短而完整的回应可以一条，独立回应、转折、补充可以分条。不按字数、句号或空行机械拆分；完整代码、命令与精确引用不拆散。
${stickerAvailable ? '表情包可选，使用 {kind:"sticker",sticker_id:"..."}；必须在本轮更早的已完成步骤用 sticker_preview 看过同一 id 的实际画面。可以纯文字、纯表情、表情在文字前/后或两段文字之间。没有固定数量或搭配；看过并不意味着要发送。' : "当前没有表情发送能力，只提交文字。"}
parts 顺序就是发送顺序；同次调用会发完全部单元，不用为了分条设置 continue。channel 留空发当前频道，OneBot 群使用裸群号；混排表情不支持跨频道。mode=element（默认）解析 <at>/<quote>/<img>/<file>，资源用真实 URI，<text>...</text> 是逐字块；普通尖括号需转义。mode=raw 原样发送纯文本。continue 默认 false 结束本轮；之后还要做工具工作时必须预先设 true。
${innerThought ? "inner_thought 是私有行为判断，不是角色台词，不会发送。" : ""}
返回 replyReceipt 和真实平台 ID。发送遇错立即停止，已发送前缀不会重发；不要通过另一个工具或后续调用重发同一份回复。`;
}

function authoredSendTool(options: ReplyToolsOptions, coordinator: ReplyCoordinator, allowed: (turnId: string) => boolean): AgentTool {
  return {
    name: "send_message",
    terminal: (input: { continue?: boolean }) => input.continue !== true,
    description: authoredDescription(options.innerThought, options.sticker !== undefined),
    inputSchema: jsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        parts: {
          type: "array",
          minItems: 1,
          maxItems: 13,
          items: {
            oneOf: [
              {
                type: "object",
                properties: { kind: { const: "text" }, text: { type: "string", minLength: 1 } },
                required: ["kind", "text"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { kind: { const: "sticker" }, sticker_id: { type: "string", minLength: 1 } },
                required: ["kind", "sticker_id"],
                additionalProperties: false,
              },
            ],
          },
        },
        ...controlProperties(options.innerThought),
      },
      required: ["parts"],
      additionalProperties: false,
    }),
    execute: async (input, execution) => {
      const value = record(input);
      if (!value || !keysOnly(value, ["parts", "channel", "mode", "continue", ...(options.innerThought ? ["inner_thought"] : [])]) || !validControls(value))
        return replyPreflightFailure("InvalidInput", "只能提交完整 parts 和有效的发送控制").output;
      return (
        await coordinator.deliver({
          parts: value.parts,
          ...executionInput(execution, allowed),
          channel: value.channel as string | undefined,
          mode: value.mode,
          keepGoing: value.continue === true,
        })
      ).output;
    },
  };
}

function executionInput(execution: AgentToolExecuteContext, allowed: (turnId: string) => boolean) {
  return {
    turnId: execution.turnId,
    toolCallId: execution.toolCallId,
    messages: execution.messages,
    signal: execution.abortSignal,
    allowed: allowed(execution.turnId),
    stillAllowed: () => allowed(execution.turnId),
  };
}

function validControls(value: Record<string, unknown>): boolean {
  return (
    (value.channel === undefined || (typeof value.channel === "string" && !!value.channel.trim())) &&
    (value.mode === undefined || value.mode === "raw" || value.mode === "element") &&
    (value.continue === undefined || typeof value.continue === "boolean") &&
    (value.inner_thought === undefined || typeof value.inner_thought === "string")
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function keysOnly(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function controlProperties(innerThought: boolean) {
  return {
    channel: { type: "string" as const, minLength: 1 },
    mode: { type: "string" as const, enum: ["element", "raw"] },
    continue: { type: "boolean" as const },
    ...(innerThought ? { inner_thought: { type: "string" as const, description: "私有行为判断，不会发送" } } : {}),
  };
}

export type { ReplyPart };
