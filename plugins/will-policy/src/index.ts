import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Context, Logger, Schema, type Command, type Session } from "koishi";
import type { ChannelContext, WillEngine, WillPlugin } from "koishi-plugin-yesimbot";

import { resolvePolicy } from "./policy.js";
import { PolicyRoutingEngine } from "./routing.js";
import { createDurableWillingnessStore, type WillingnessStore } from "./store.js";
import type { WillPolicyConfig } from "./types.js";
import { PolicyWillingnessEngine } from "./willingness.js";

export const WillPolicyConfigSchema: Schema<WillPolicyConfig> = Schema.intersect([
  Schema.object({
    engine: Schema.union([Schema.const("routing").description("固定规则（routing）"), Schema.const("willingness").description("意愿值引擎(willingness)")])
      .default("routing")
      .description("该克隆实例使用的引擎；routing 适合稳定规则，willingness 适合动态活跃度"),
    priority: Schema.number().default(1000).description("WillEngine 优先级，数值小者先执行"),
  }),
  Schema.union([
    Schema.object({
      engine: Schema.const("routing"),
      routing: Schema.object({
        direct: Schema.union(["wait", "trigger"]).default("trigger").description("私聊消息"),
        mention: Schema.union(["wait", "trigger"]).default("trigger").description("@ 机器人"),
        mentionAll: Schema.union(["wait", "trigger"]).default("wait").description("@全体成员"),
        mentionHere: Schema.union(["wait", "trigger"]).default("wait").description("@在线成员"),
        quote: Schema.union(["wait", "trigger"]).default("wait").description("引用/回复消息"),
        image: Schema.union(["wait", "trigger"]).default("wait").description("含图片的消息"),
        poke: Schema.union(["wait", "trigger"]).default("wait").description("拍一拍事件"),
        group: Schema.union(["wait", "trigger"]).default("wait").description("普通群消息"),
      })
        .required()
        .description("固定规则引擎配置；仅在 engine 为 routing 时生效"),
    }),
    Schema.object({
      engine: Schema.const("willingness"),
      willingness: Schema.object({
        batchDecision: Schema.union(["per-input", "highest-candidate"])
          .default("per-input")
          .description("per-input 保持旧逐条判定；highest-candidate 对整个防抖批次只判定一次"),
        decayMode: Schema.union(["weighted", "half-life"]).default("weighted").description("weighted 保持旧热/温窗口衰减；half-life 使用严格指数半衰期"),
        persistState: Schema.boolean().default(false).description("将批次意愿状态原子持久化到频道资源目录"),
        maxScore: Schema.number().min(0.000_001).default(100).description("意愿值上限"),
        initialScore: Schema.number().min(0).default(0).description("初始意愿值，不得超过 maxScore"),
        decayHalfLifeSeconds: Schema.number().min(0.001).default(600).description("意愿值半衰期(秒)"),
        probabilityThreshold: Schema.number().min(0).default(55).description("触发概率阈值，不得超过 maxScore"),
        probabilityAmplifier: Schema.number().min(0).default(0.04).description("超过阈值后的概率放大系数"),
        replyCost: Schema.number().min(0).default(35).description("旧模式触发时立即扣分；批次模式在真实送达后确认扣分"),
        textGain: Schema.number().min(0).default(12).description("每条输入的基础互动增益"),
        mentionGain: Schema.number().min(0).default(100).description("明确 @ 当前机器人时的临时候选增益"),
        quoteGain: Schema.number().min(0).default(15).description("明确引用当前机器人时的临时候选增益"),
        directGain: Schema.number().min(0).default(40).description("私聊时的临时候选增益"),
        imageGain: Schema.number().min(0).default(8).description("旧逐条模式的图片增益；批次模式不增加图片分"),
        pokeGain: Schema.number().min(0).default(80).description("定向 poke 的临时候选增益"),
        keywords: Schema.array(Schema.string().min(1)).default([]).description("NFKC 规范化并忽略大小写的高兴趣关键词"),
        keywordMultiplier: Schema.number().min(0).default(1.2).description("命中关键词时的乘数"),
        defaultMultiplier: Schema.number().min(0).default(1).description("未命中关键词时的默认乘数"),
        hotWindowSeconds: Schema.number().min(0).default(15).description("旧 weighted 模式热窗口秒数"),
        warmWindowSeconds: Schema.number().min(0).default(60).description("旧 weighted 模式温窗口秒数，不得小于热窗口"),
        hotDecayWeight: Schema.number().min(0).default(0.3).description("旧 weighted 模式热窗口衰减权重"),
        warmDecayWeight: Schema.number().min(0).default(0.7).description("旧 weighted 模式温窗口衰减权重"),
        mentionForce: Schema.boolean().default(false).description("旧逐条模式被 @ 时强制触发"),
        quoteForce: Schema.boolean().default(false).description("旧逐条模式引用时强制触发"),
        directForce: Schema.boolean().default(false).description("旧逐条模式私聊强制触发"),
      })
        .required()
        .description("意愿值引擎配置；仅在 engine 为 willingness 时生效"),
    }),
  ]),
]);

const DEBUG_COMMAND_NAME = "yesimbot.will-policy";

const DEBUG_PROBES = new WeakMap<Context, Set<WillPolicyPlugin>>();

const DEBUG_COMMANDS = new WeakMap<Context, Command>();

const DEBUG_ACTION: unique symbol = Symbol("yesimbot.will-policy.debug-action");

const DURABLE_STORES = new Map<string, Promise<WillingnessStore>>();

type DebugCommand = Command & { [DEBUG_ACTION]?: boolean };

export default class WillPolicyPlugin implements WillPlugin {
  public static readonly name = "yesimbot-will-policy";
  public static readonly reusable = true;
  public static readonly inject = ["yesimbot"];
  public static readonly usage = "提供可克隆、可筛选、可组合的 WillEngine 与 routing 策略";
  public static readonly Config: Schema<WillPolicyConfig> = WillPolicyConfigSchema;

  public readonly ctx: Context;
  public readonly config: WillPolicyConfig;
  public readonly logger: Logger;
  public readonly priority: number;

  private readonly instanceId = randomUUID();
  private disposeWillPlugin?: () => void;

  public constructor(ctx: Context, config: WillPolicyConfig) {
    this.ctx = ctx;
    this.config = config;
    this.priority = config.priority ?? 1000;
    this.logger = ctx.logger("yesimbot.will-policy");
    this.logger.level = ctx.yesimbot.config.logLevel ?? 2;
    ctx.on("ready", this.start.bind(this));
    ctx.on("dispose", this.stop.bind(this));
  }

  public async start(): Promise<void> {
    this.disposeWillPlugin?.();
    this.disposeWillPlugin = this.ctx.yesimbot.agent.will(this);
    this.registerDebugProbe();
    this.logger.success("Will policy plugin started", { instanceId: this.instanceId });
  }

  public match(session: Session): boolean {
    const matched = this.ctx.filter(session);
    this.logger.debug("will_policy.match", {
      instanceId: this.instanceId,
      priority: this.priority,
      engine: this.config.engine,
      platform: session.platform,
      channelId: session.channelId,
      guildId: session.guildId,
      matched,
    });
    return matched;
  }

  public matchContext(context: ChannelContext): boolean {
    const bot =
      this.ctx.bots.find((candidate) => candidate.platform === context.platform && (!context.selfId || candidate.selfId === context.selfId)) ??
      this.ctx.bots[0];
    if (!bot) {
      this.logger.debug("will_policy.match_context", {
        instanceId: this.instanceId,
        priority: this.priority,
        engine: this.config.engine,
        platform: context.platform,
        channelId: context.channelId,
        guildId: context.type === "direct" ? undefined : context.guildId,
        matched: false,
        reason: "no_bot",
      });
      return false;
    }

    const isDirect = context.type === "direct";

    const session = bot.session({
      type: "message-created",
      subtype: isDirect ? "private" : "group",
      platform: context.platform,
      selfId: context.selfId,
      timestamp: Date.now(),
      channel: { id: context.channelId, type: isDirect ? 1 : 0 },
      ...(!isDirect && context.guildId ? { guild: { id: context.guildId } } : {}),
      ...(isDirect ? { user: { id: context.userId, ...(context.userName ? { name: context.userName } : {}) } } : {}),
    } as never) as Session;
    const matched = this.ctx.filter(session);
    this.logger.debug("will_policy.match_context", {
      instanceId: this.instanceId,
      priority: this.priority,
      engine: this.config.engine,
      platform: context.platform,
      channelId: context.channelId,
      guildId: isDirect ? undefined : context.guildId,
      matched,
    });
    return matched;
  }

  public async setup(scope: ChannelContext): Promise<WillEngine> {
    const resolved = resolvePolicy(this.config);
    this.logger.debug("resolve_will_policy", { engine: resolved.engine, routing: resolved.routing, willingness: resolved.willingness });
    if (resolved.engine === "routing") return new PolicyRoutingEngine(resolved.routing, this.logger);

    const selfId = resolveSelfId(this.ctx, scope);
    let store: WillingnessStore | undefined;
    if (resolved.willingness.persistState) {
      if (!selfId) throw new Error("Persistent willingness requires a resolved Bot selfId");
      const resources = await this.ctx.yesimbot.resource.get(scope);
      store = await durableStore(join(resources.path, "willingness.json"), this.logger);
    }
    const engine = new PolicyWillingnessEngine(resolved.willingness, this.logger, { selfId, store });
    await engine.initialize();
    return engine;
  }

  public async stop(): Promise<void> {
    const root = this.ctx.root;
    const probes = DEBUG_PROBES.get(root);
    probes?.delete(this);
    if (probes?.size === 0) {
      DEBUG_COMMANDS.get(root)?.dispose();
      DEBUG_COMMANDS.delete(root);
      DEBUG_PROBES.delete(root);
    }
    this.disposeWillPlugin?.();
    this.disposeWillPlugin = undefined;
  }

  private registerDebugProbe(): void {
    const root = this.ctx.root;
    const probes = DEBUG_PROBES.get(root) ?? new Set<WillPolicyPlugin>();
    probes.add(this);
    DEBUG_PROBES.set(root, probes);

    let command = DEBUG_COMMANDS.get(root);
    if (!command) {
      command = root.command(DEBUG_COMMAND_NAME, "检查当前 WillEngine 策略实例", { authority: 4 });
      DEBUG_COMMANDS.set(root, command);
    }
    const debugCommand = command as DebugCommand;
    if (debugCommand[DEBUG_ACTION]) return;
    Object.defineProperty(debugCommand, DEBUG_ACTION, { value: true });
    debugCommand.action(async ({ session }) => {
      if (!session) return;
      const matches = [...probes].filter((probe) => probe.ctx.filter(session));
      if (matches.length === 0) return;
      return matches.map((probe) => probe.instanceDescription()).join("\n");
    });
  }

  private instanceDescription(): string {
    return [`WillPolicy[${this.instanceId.slice(0, 8)}]`, `engine=${this.config.engine}`, `priority=${this.priority}`].join(" ");
  }
}

function resolveSelfId(ctx: Context, scope: ChannelContext): string | undefined {
  if (scope.selfId) return scope.selfId;
  const matching = ctx.bots.filter((bot) => bot.platform === scope.platform);
  return matching.length === 1 ? matching[0]?.selfId : undefined;
}

function durableStore(path: string, logger: Pick<Logger, "warn">): Promise<WillingnessStore> {
  const existing = DURABLE_STORES.get(path);
  if (existing) return existing;
  const store = createDurableWillingnessStore(path, logger);
  const pending = store.init().then(() => store);
  DURABLE_STORES.set(path, pending);
  void pending.catch(() => {
    if (DURABLE_STORES.get(path) === pending) DURABLE_STORES.delete(path);
  });
  return pending;
}
