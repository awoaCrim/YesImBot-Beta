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

const CHANNEL_MEMORY_PROMPT = `## 长期记忆工具

你有三个记忆工具可用：

### recall — 快速检索（零/低成本）
从记忆库中按关键词、标签、类型检索已存储的记忆。适用于：
- 回复前快速获取相关背景（某人的偏好、身份、历史）
- 确认某个事实是否已知
- 参数建议：query 用关键名词，types 缩小范围，limit 控制数量
- 换了说法、同义词或存在错别字时关键词会漏，此时加 semantic: true 做语义召回（会消耗一次 embedding 调用）

### remember — 提交记忆整理请求
当对话中出现值得长期记住的信息时调用。后台 Maintainer 会批量处理。
- content：对记忆主题的简洁描述（如"用户表达了对 X 的偏好"）
- sources：相关消息的 messageId 列表（作为证据）

**何时 remember**：
- 新的持久事实（某人的职业、技能、物品）
- 明确表达的偏好或习惯
- 关系变化（新认识的人、角色变动）
- 重要事件（项目决策、里程碑）
- 群组共识形成

**不要 remember**：
- 临时性请求（"帮我查个东西"）
- 纯情绪/玩笑/无信息量的聊天
- 已经记忆过的相同信息
- 敏感凭据（密码、token）

### search — 深度搜索（启动 Agent，有成本）
当需要交叉验证多条记忆、推理复杂问题时使用。返回结构化报告。
- 适用于："某人和某人上次合作结果如何"、"群里对这个话题的共识是什么"
- 不适用于简单事实查询（用 recall）
`;

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
