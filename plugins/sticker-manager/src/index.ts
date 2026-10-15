import { EphemeralImageProjectionStore, type AgentPlugin } from "@yesimbot/agent-runtime";
import { Context, Logger, type Bot } from "koishi";
import type { ChannelPluginSetupContext, ChannelResources, ChannelContext } from "koishi-plugin-yesimbot";

import { ModelStickerClassifier } from "./classifier.js";
import { registerStickerCommands } from "./commands.js";
import { StickerConfigSchema } from "./config.js";
import { StickerDeliveryService } from "./delivery.js";
import { StickerFileStore } from "./files.js";
import { StickerPreviewGate, StickerSendSlot } from "./preview-evidence.js";
import { createStickerPreviewTool } from "./preview-tool.js";
import { BotStickerSender } from "./sender.js";
import { projectStickerElements, projectStickerHistoryElements } from "./sticker-element.js";
import { registerStickerModel, StickerStore } from "./store.js";
import { createStickerTools, stickerSendMessageBlockReason } from "./tools.js";
import { scopeKeyFor, type StickerConfig } from "./types.js";

export default class StickerManagerPlugin {
  public static readonly name = "yesimbot-sticker-manager";
  public static readonly inject = ["yesimbot", "database"];
  public static readonly Config = StickerConfigSchema;
  public static readonly usage = "表情包收藏、分类、导入和管理插件";

  public readonly ctx: Context;
  public readonly config: StickerConfig;
  public readonly logger: Logger;
  public readonly store: StickerStore;

  private started = false;
  private capabilityRevisionValue = 0;
  private classifier: ModelStickerClassifier | undefined;
  private disposeAgentPlugin?: () => void;
  private disposeCommands?: () => void;

  public constructor(ctx: Context, config: StickerConfig) {
    this.ctx = ctx;
    this.config = config;
    this.logger = ctx.logger("yesimbot.sticker-manager");
    const files = new StickerFileStore(ctx.baseDir, config.storagePath);
    registerStickerModel(ctx.model);
    this.store = new StickerStore(ctx.model, files);
    ctx.on("ready", this.start.bind(this));
    ctx.on("dispose", this.stop.bind(this));
  }

  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.store.ensure();
      const classifier = new ModelStickerClassifier(this.ctx, this.config);
      this.classifier = classifier;
      this.disposeAgentPlugin = this.ctx.yesimbot.agent.use(this);
      this.disposeCommands = registerStickerCommands({ ctx: this.ctx, store: this.store, classifier, config: this.config });
      this.logger.success("Sticker manager plugin started");
    } catch (cause) {
      this.started = false;
      this.stop().catch((stopCause) => this.logger.warn("sticker_plugin_stop_failed", { cause: stopCause }));
      throw cause;
    }
  }

  public async setup(scope: ChannelContext, bot: Bot, runtime?: ChannelPluginSetupContext): Promise<AgentPlugin | null> {
    const classifier = this.classifier;
    if (!classifier) return null;
    const resources = await this.ctx.yesimbot.resource.get(scope);
    return this.createAgentPlugin(scope, bot, resources, classifier, runtime);
  }

  /** Registers one typed modern capability for this channel; the disposer is idempotent. */
  public registerDelivery(scope: ChannelContext, bot: Bot, runtime: ChannelPluginSetupContext, delivery: StickerDeliveryService): (() => void) | undefined {
    const register = runtime.replyDelivery?.registerSticker;
    if (!register || runtime.replyDelivery?.version !== 1) return undefined;
    let disposed = false;
    let generation = 0;
    const getRevision = () => this.capabilityRevision;
    const revision = getRevision();
    const current = () => !disposed && getRevision() === revision;
    const dispose = register({
      get revision() {
        return getRevision() + generation;
      },
      status: (turnId) => (current() ? delivery.status(turnId) : "unavailable"),
      catalog: () => (current() ? delivery.catalog() : Promise.resolve([])),
      view: (turnId, messages) => (current() ? delivery.view(turnId, messages) : Promise.resolve(undefined)),
      isViewCurrent: (view, turnId) => current() && delivery.isViewCurrent(view, turnId),
      preflight: (input) =>
        current()
          ? delivery.preflight({ ...input, stillAllowed: () => current() && (input.stillAllowed?.() ?? true) })
          : Promise.resolve({ error: "StickerCapabilityRetired" }),
    });
    return () => {
      if (disposed) return;
      disposed = true;
      generation++;
      dispose();
    };
  }

  private createAgentPlugin(
    scope: ChannelContext,
    bot: Bot,
    resources: ChannelResources,
    classifier: ModelStickerClassifier,
    runtime: ChannelPluginSetupContext | undefined,
  ): AgentPlugin {
    const modern = runtime?.replyDelivery?.version === 1;
    const deliveryMode: "legacy" | "authored" = modern ? runtime.replyDelivery!.ownership : "legacy";
    const disposeChannelOutput = runtime?.channelOutput?.version === 1 ? runtime.channelOutput.registerTools(["sticker_send"]) : undefined;
    let channelOutputDisposed = false;
    const disposeRegisteredChannelOutput = () => {
      if (channelOutputDisposed) return;
      channelOutputDisposed = true;
      disposeChannelOutput?.();
    };
    const artifactIds = new Map<string, string>();
    const sendSlot = new StickerSendSlot();
    const previewGate = new StickerPreviewGate();
    const scopeKey = scopeKeyFor(scope, this.config);
    const sender = new BotStickerSender(bot, scope);
    const revision = this.capabilityRevision;
    let retired = false;
    let activeTurn: { id: string } | undefined;
    let closedTurn: string | undefined;
    const captureTurn = (turnId: string) => {
      const captured = activeTurn;
      return () => !retired && this.capabilityRevision === revision && !!captured && captured.id === turnId && activeTurn === captured;
    };
    const delivery = new StickerDeliveryService({
      store: this.store,
      sender,
      scope,
      config: this.config,
      sendSlot,
      previewGate,
      captureTurn,
      onUsageWarning: (stickerId, cause) => this.logger.warn("sticker_usage_update_failed", { stickerId, cause }),
    });
    const disposeDelivery = this.registerDelivery(scope, bot, runtime ?? { imageProjection: new EphemeralImageProjectionStore() }, delivery);
    return {
      name: "sticker-manager",
      tools: () => [
        createStickerPreviewTool({
          store: this.store,
          config: this.config,
          scopeKey,
          // The Core-owned store keeps preview bytes visible for the bounded live turn and out of
          // durable history; without it a preview has nothing to project.
          projection: runtime?.imageProjection ?? new EphemeralImageProjectionStore(),
          previewCapability: runtime?.imagePreview,
          gate: previewGate,
          deliveryMode,
          captureTurn,
        }),
        ...createStickerTools({
          store: this.store,
          classifier,
          sender,
          assets: resources.assets,
          scope,
          config: this.config,
          sendSlot,
          previewGate,
          delivery,
          captureTurn,
        }).filter((tool) => !modern || tool.name !== "sticker_send"),
      ],
      beforeToolCall: (call) => {
        // A legacy sticker artifact URI or a bare <sticker/> element in send_message would deliver
        // unread bytes through the text-resource path, bypassing exact-record admission and the quota.
        if (call.toolName !== "send_message") return;
        const reason = stickerSendMessageBlockReason(call.args);
        return reason ? { type: "block", reason } : undefined;
      },
      onTurnFinish: (_result, context) => {
        if (activeTurn?.id === context.turnId) {
          activeTurn = undefined;
          closedTurn = context.turnId;
        }
        delivery.finishTurn(context.turnId);
      },
      stop: () => {
        retired = true;
        activeTurn = undefined;
        disposeDelivery?.();
        disposeRegisteredChannelOutput();
        delivery.stop();
      },
      prepareStep: (messages, context) => {
        if (retired || this.capabilityRevision !== revision || closedTurn === context.turnId) return messages;
        if (activeTurn?.id !== context.turnId) {
          if (activeTurn) delivery.finishTurn(activeTurn.id);
          activeTurn = { id: context.turnId };
        }
        return messages;
      },
      onAppend: (entries) =>
        projectStickerElements(entries, {
          store: this.store,
          artifacts: resources.artifacts,
          scopeKey,
          config: this.config,
          artifactIds,
        }),
      transformEntries: (entries) =>
        projectStickerHistoryElements(entries, {
          store: this.store,
          artifacts: resources.artifacts,
          scopeKey,
          config: this.config,
          artifactIds,
        }),
      appendSystemPrompt: () => formatStickerPrompt(this.config, deliveryMode),
    } satisfies AgentPlugin;
  }

  private get capabilityRevision(): number {
    return this.capabilityRevisionValue;
  }

  public async stop(): Promise<void> {
    this.started = false;
    this.capabilityRevisionValue += 1;
    this.disposeAgentPlugin?.();
    this.disposeAgentPlugin = undefined;
    this.classifier = undefined;
    this.disposeCommands?.();
    this.disposeCommands = undefined;
    this.logger.info("Sticker manager plugin stopped");
  }
}

function formatStickerPrompt(config: StickerConfig, mode: "legacy" | "authored" = "legacy"): string {
  return [
    "表情包可按当前语境自主选用；需要时用 sticker_categories 或 sticker_search 查询当前库，具体用法见工具说明。",
    mode === "legacy" ? "发送使用 sticker_send。" : "发送使用 send_message 的 sticker parts。",
    ...(config.enableSteal ? ["sticker_steal 可收藏已实际看过的聊天图片。"] : []),
    ...(config.enableManage === true ? ["sticker_manage 可整理库内分类和单张记录。"] : []),
    ...(config.tagMode ? ["sticker_tags 可查询实验性标签。"] : []),
  ].join("\n");
}
