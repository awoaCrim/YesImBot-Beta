import { jsonSchema, type AgentMessage, type AgentTool, type AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import { isMessage, type ChannelContext, type ConversationReadOptions, type MessageRecord } from "koishi-plugin-yesimbot";

import { MemoryStore } from "./store/memory.js";
import { PendingStore } from "./store/pending.js";
import { type MemoryRecall, type MemoryScope, type MemorySearchReport, type MemoryType } from "./types.js";

const RECALL_SCHEMA = jsonSchema<RecallInput>({
  type: "object",
  properties: {
    query: { type: "string", description: "关键词搜索，匹配记忆内容和标签" },
    tags: { type: "array", items: { type: "string" }, description: "按标签过滤（交集匹配）" },
    types: {
      type: "array",
      items: { type: "string", enum: ["fact", "preference", "event", "relationship", "knowledge", "experience"] },
      description: "按记忆类型过滤",
    },
    scope: { type: "string", enum: ["channel", "user", "shared"], description: "限定记忆范围" },
    semantic: { type: "boolean", description: "启用语义召回：关键词命中之外，还会召回向量相似度足够高的记忆，并把相似度并入排序" },
    limit: { type: "integer", minimum: 1, maximum: 50, description: "最大返回条数" },
  },
  additionalProperties: false,
});

const REMEMBER_SCHEMA = jsonSchema<RememberInput>({
  type: "object",
  properties: {
    content: { type: "string", minLength: 1 },
    sources: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
    scope: { type: "string", enum: ["channel", "user", "shared"] },
  },
  required: ["content", "sources"],
  additionalProperties: false,
});

const SEARCH_SCHEMA = jsonSchema<SearchInput>({
  type: "object",
  properties: {
    query: { type: "string", minLength: 1 },
    scope: { type: "string", enum: ["channel", "user", "shared"] },
    limit: { type: "integer", minimum: 1, maximum: 50 },
  },
  required: ["query"],
  additionalProperties: false,
});

interface RecallInput {
  readonly query?: string;
  readonly tags?: string[];
  readonly types?: MemoryType[];
  readonly scope?: MemoryScope;
  readonly semantic?: boolean;
  readonly limit?: number;
}

interface RememberInput {
  readonly content: string;
  readonly sources: string[];
  readonly scope?: MemoryScope;
}

interface SearchInput {
  readonly query: string;
  readonly scope?: MemoryScope;
  readonly limit?: number;
}

export function createChannelTools(
  context: ChannelContext,
  store: MemoryStore,
  pending: PendingStore,
  options: {
    batchDelayMs?: number;
    evidenceCount: (memoryId: string) => Promise<number>;
    readConversation: (context: ChannelContext, options: ConversationReadOptions) => Promise<MessageRecord[]>;
    rearm: () => Promise<void>;
    search: (input: SearchInput, execution: AgentToolExecuteContext) => Promise<MemorySearchReport>;
  },
): AgentTool[] {
  const recall: AgentTool<RecallInput, { memories: MemoryRecall[]; semanticUsed: boolean }> = {
    name: "recall",
    description:
      "检索当前频道、当前轮参与者和全局可见的长期记忆。可按 query、tags、types、scope、limit 过滤；关键词不足时可将 semantic 设为 true，返回结果包含证据数量和相对时间。",

    inputSchema: RECALL_SCHEMA,
    execute: async (input, execution) => {
      const current = execution as unknown as AgentToolExecuteContext;
      const userIds = participants(current.messages);
      const result = await store.searchVisible(context, userIds, {
        query: input.query,
        tags: input.tags,
        types: input.types,
        scopes: input.scope ? [input.scope] : undefined,
        limit: input.limit,
        semantic: input.semantic,
      });
      await store.touch(result.memories.map((memory) => memory.id));
      return {
        memories: await Promise.all(result.memories.map(async (memory) => toRecall(memory, options.evidenceCount))),
        semanticUsed: result.semanticUsed,
      };
    },
  };
  const remember: AgentTool<RememberInput, { queued: true; pendingId: string; sourceCount: number }> = {
    name: "remember",
    description:
      "将当前频道的指定消息上下文加入后台长期记忆整理队列。content 写要保留的事实或偏好，sources 必须是相关 messageId；可选 scope 控制记忆可见范围。",

    inputSchema: REMEMBER_SCHEMA,
    execute: async (input, execution) => {
      const sources = [...new Set(input.sources)];
      if (!input.content.trim() || !sources.length) throw new Error("memory request needs non-empty content and sources");
      const messages = await options.readConversation(context, { messageIds: sources, before: 10, after: 10, limit: 50 });
      const current = execution as unknown as AgentToolExecuteContext;
      const item = await pending.enqueue(
        {
          content: input.content,
          sources,
          scope: input.scope,
          channel: context,
          turnId: current.turnId,
          messageCount: messages.length,
          queuedAt: Date.now(),
        },
        options.batchDelayMs,
      );
      await options.rearm();
      return { queued: true, pendingId: item.id, sourceCount: sources.length };
    },
  };
  const search: AgentTool<SearchInput, MemorySearchReport> = {
    name: "search",
    description: "让记忆代理基于已授权的记忆和证据生成结构化报告。query 必填；需要复杂交叉验证时使用，简单事实优先使用 recall。",

    inputSchema: SEARCH_SCHEMA,
    execute: (input, execution) => options.search(input, execution as unknown as AgentToolExecuteContext),
  };
  return [remember, recall, search];
}

export function participants(messages: readonly AgentMessage[]): string[] {
  return [...new Set(messages.filter(isMessage).map((message) => message.data.user.id))];
}

export async function toRecall(
  memory: { id: string; type: MemoryType; content: string; scope: MemoryScope; importance: number; confidence: number; updatedAt: number },
  evidenceCount: (memoryId: string) => Promise<number>,
): Promise<MemoryRecall> {
  return {
    id: memory.id,
    type: memory.type,
    content: memory.content,
    scope: memory.scope,
    importance: memory.importance,
    confidence: memory.confidence,
    updatedAt: memory.updatedAt,
    relativeTime: relativeTime(memory.updatedAt),
    evidenceCount: await evidenceCount(memory.id),
  };
}

function relativeTime(updatedAt: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - updatedAt) / 60_000));
  return minutes < 1 ? "just now" : `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}
