import { resolve } from "node:path";

import type { AgentPlugin } from "@yesimbot/agent-runtime";
import { Schema, type Bot, type Context, type Logger } from "koishi";
import type { ChannelContext } from "koishi-plugin-yesimbot";

import { runMaintenance } from "./maintainer.js";
import { createChannelTools } from "./plugin.js";
import { MemoryScheduler } from "./scheduler.js";
import { runSearch } from "./searcher.js";
import { createEmbeddingIndexer } from "./semantic.js";
import { EvidenceStore } from "./store/evidence.js";
import { MemoryStore } from "./store/memory.js";
import { PendingStore } from "./store/pending.js";
import type { MemorizerConfig } from "./types.js";

export const Config: Schema<MemorizerConfig> = Schema.object({
  model: Schema.dynamic("registry.chatModels").default("").description("已弃用：记忆维护和搜索统一使用 YesImBot auxiliaryModel"),
  embeddingModel: Schema.dynamic("registry.embeddingModels").default(""),
  dataPath: Schema.string().default("data/yesimbot/memorizer"),
  batchDelayMs: Schema.number()
    .min(1_000)
    .default(5 * 60 * 1_000),
  maxPendingPerBatch: Schema.natural().min(1).default(10),
  maxMessagesPerBatch: Schema.natural().min(1).default(300),
  searchTimeoutMs: Schema.natural()
    .min(1_000)
    .default(60 * 1_000),
  halfLifeDays: Schema.number().min(1).default(90),
  forgottenGraceDays: Schema.number().min(1).default(30),
  maxActivePerScope: Schema.natural().min(1).default(1_000),
  semanticMinSimilarity: Schema.number().min(0).max(1).default(0.35).description("语义召回的最低余弦相似度；低于该值且关键词未命中的记忆不会被召回"),
  semanticBoostWeight: Schema.number().min(0).default(1).description("相似度对排序的影响强度：score = retention × confidence × (1 + weight × similarity)"),
  semanticQueryPrefix: Schema.string().description(
    "查询侧指令前缀。留空则按 embedding 模型自动选择（bge-*-zh 系列会自动加官方检索指令），显式填写空字符串可强制关闭。",
  ),
});

const CHANNEL_MEMORY_PROMPT = `## 长期记忆

你可以使用 recall、remember、search 三个记忆工具。记忆不是聊天记录：只保留有长期价值、可由当前证据支持且不涉及敏感凭据的内容。

- **recall**：低成本获取当前回应需要的背景或确认已知事实；普通事实先用它，必要时再启用语义召回。
- **remember**：遇到持久事实、明确偏好、关系变化、重要事件或群体共识时提交整理请求，并提供相关消息作为证据。不要记录临时请求、纯情绪/玩笑、重复记忆、密码或 token。
- **search**：需要交叉验证多条记忆或回答复杂关系问题时使用；简单事实优先 recall。

记忆内容和回复都要区分证据、推测与不确定性；具体字段、范围和限制以工具 schema 为准。`;

export default class MemoryAgentPlugin {
  public static readonly name = "yesimbot-memorizer";
  public static readonly usage = "为 YesImBot 提供带证据的长期记忆";
  public static readonly inject = ["yesimbot", "database"];
  public static readonly Config = Config;

  private readonly store: MemoryStore;
  private readonly evidence: EvidenceStore;
  private readonly config: MemorizerConfig;
  private readonly pending: PendingStore;
  private readonly scheduler: MemoryScheduler;
  private readonly logger: Logger;
  private disposeAgentPlugin?: () => void;
  private started = false;

  public constructor(
    private readonly ctx: Context,
    config: MemorizerConfig,
  ) {
    this.config = config;
    this.logger = ctx.logger("yesimbot.memorizer");
    const root = resolve(ctx.baseDir, config.dataPath || "data/yesimbot/memorizer");
    const embeddingModelId = config.embeddingModel?.trim();
    const indexer = embeddingModelId
      ? createEmbeddingIndexer({
          modelId: embeddingModelId,
          queryPrefix: config.semanticQueryPrefix,
          resolve: () => this.ctx.yesimbot.model.resolveEmbedding(embeddingModelId),
          warn: (event, fields) => this.logger.warn(event, fields),
        })
      : undefined;
    this.store = new MemoryStore(ctx, {
      indexer,
      halfLifeDays: config.halfLifeDays ?? 90,
      semantic: {
        minSimilarity: config.semanticMinSimilarity ?? 0.35,
        boostWeight: config.semanticBoostWeight ?? 1,
      },
    });
    this.evidence = new EvidenceStore(root);
    this.pending = new PendingStore(root);
    this.scheduler = new MemoryScheduler(
      this.pending,
      async (channel, batch) => {
        const messages = await this.ctx.yesimbot.conversation.read(channel, {
          messageIds: [...new Set(batch.flatMap((item) => item.sources))],
          before: 10,
          after: 10,
          limit: this.config.maxMessagesPerBatch,
        });
        await runMaintenance({
          model: this.ctx.yesimbot.model.resolveAuxiliaryModel("memory-summary", channel).model,
          context: channel,
          messages,
          store: this.store,
          evidence: this.evidence,
          request: batch.map((item) => item.content).join("\n"),
          allowShared: batch.some((item) => item.scope === "shared"),
        });
      },
      { maxPending: config.maxPendingPerBatch ?? 10, maxMessages: config.maxMessagesPerBatch ?? 300 },
      () =>
        this.store
          .sweep(
            Date.now(),
            {
              halfLifeDays: this.config.halfLifeDays ?? 90,
              forgottenGraceDays: this.config.forgottenGraceDays ?? 30,
              maxActivePerScope: this.config.maxActivePerScope ?? 1_000,
            },
            (id) => this.evidence.remove(id),
          )
          .then(async () => {
            const indexed = await this.store.reindex();
            if (indexed > 0) this.logger.info("memorizer.embedding_reindexed", { indexed, remaining: await this.store.missingEmbeddings() });
          }),
    );
    ctx.on("ready", this.start.bind(this));
    ctx.on("dispose", this.stop.bind(this));
  }

  public async start(): Promise<void> {
    if (this.started) return;
    await this.pending.init();
    await this.scheduler.start();
    this.disposeAgentPlugin = this.ctx.yesimbot.agent.use(this);
    this.started = true;
  }

  public setup(context: ChannelContext, _bot: Bot): AgentPlugin {
    return {
      name: "memory-agent",
      appendSystemPrompt: () => CHANNEL_MEMORY_PROMPT,
      tools: () =>
        createChannelTools(context, this.store, this.pending, {
          batchDelayMs: this.config.batchDelayMs,
          evidenceCount: (id) => this.evidence.count(id),
          readConversation: this.ctx.yesimbot.conversation.read,
          rearm: () => this.scheduler.arm(),
          search: (value, execution) =>
            runSearch({
              model: this.ctx.yesimbot.model.resolveAuxiliaryModel("utility", context).model,
              context,
              execution,
              store: this.store,
              evidence: this.evidence,
              query: value.query,
              scope: value.scope,
              limit: value.limit,
              timeoutMs: this.config.searchTimeoutMs ?? 60 * 1_000,
            }),
        }),
    };
  }

  public async stop(): Promise<void> {
    this.started = false;
    this.disposeAgentPlugin?.();
    this.disposeAgentPlugin = undefined;
    await this.scheduler.stop();
  }
}
