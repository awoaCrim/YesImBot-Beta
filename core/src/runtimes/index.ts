import { EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import type { LanguageModel } from "ai";
import type { Bot, Context, Logger, Session } from "koishi";

import { Agents } from "../agents/index.js";
import { createSendMessagePolisher, PolisherRegistry } from "../agents/polisher.js";
import type { ReadImagePolicy } from "../agents/tools.js";
import type { Channel, Channels } from "../channels/index.js";
import { type ChannelContext, type ChannelKey, deriveChannelKey } from "../channels/index.js";
import type { Config } from "../config.js";
import { MessageBatchRegistry } from "../message-batches/index.js";
import { AuxiliaryModelError, type ChatModelRef, ModelService } from "../models/index.js";
import { ChannelRuntime } from "./channel.js";
import { readPersona } from "./prompt.js";

export class Runtimes {
  private readonly logger: Logger;
  private readonly runtimes = new Map<string, ChannelRuntime>();
  private readonly agentRevisions = new Map<string, number>();
  private readonly messageRevisions = new Map<string, number>();
  private readonly modelRevisions = new Map<string, number | undefined>();
  private readonly polisherRevisions = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();
  private stopped = false;
  private stopTask: Promise<void> | undefined;
  private readonly messageRevisionDisposer: () => void;
  private readonly modelRevisionDisposer: () => void;

  public constructor(
    private readonly ctx: Context,
    private readonly channels: Channels,
    private readonly model: ModelService,
    private readonly config: Config,
    private readonly agents: Agents,
    private readonly messageBatches: MessageBatchRegistry = new MessageBatchRegistry(),
    private readonly polishers: PolisherRegistry = new PolisherRegistry(),
  ) {
    this.logger = ctx.logger("yesimbot.runtimes");
    this.logger.level = config.logLevel ?? 2;
    this.messageRevisionDisposer = this.messageBatches.onRevision((revision) => {
      void this.invalidateMessageRuntimes(revision);
    });
    this.modelRevisionDisposer = ctx.on("yesimbot/model-registry-changed", (revision) => {
      void this.invalidateModelRuntimes(revision);
    });
  }

  public async get(channel: Channel, bot: Bot, session?: Session): Promise<ChannelRuntime> {
    const key = runtimeKey(channel.context);
    let value!: ChannelRuntime;
    let retry = false;
    await this.serialize(key, async () => {
      this.assertOpen();
      const current = this.runtimes.get(key);
      const agentRevision = this.agents.revision;
      const currentRevision = this.agentRevisions.get(key);
      const messageRevision = this.messageBatches.revision;
      const currentMessageRevision = this.messageRevisions.get(key);
      const modelRevision = this.model.revision;
      const currentModelRevision = this.modelRevisions.get(key);
      const polisherRevision = this.polishers.revision;
      const currentPolisherRevision = this.polisherRevisions.get(key);
      const sameBot = current?.isBoundTo(bot) ?? false;
      if (
        current &&
        sameBot &&
        currentRevision === agentRevision &&
        currentMessageRevision === messageRevision &&
        currentModelRevision === modelRevision &&
        currentPolisherRevision === polisherRevision
      ) {
        value = current;
        return;
      }
      if (current) {
        const reasons = [
          ...(sameBot ? [] : ["bot"]),
          ...(currentRevision === agentRevision ? [] : ["agent_revision"]),
          ...(currentMessageRevision === messageRevision ? [] : ["message_revision"]),
          ...(currentModelRevision === modelRevision ? [] : ["model_revision"]),
          ...(currentPolisherRevision === polisherRevision ? [] : ["polisher_revision"]),
        ];
        this.logger.warn("runtimes.get.recreate", {
          key,
          reasons,
          oldSelfId: current.selfId,
          newSelfId: bot.selfId,
          oldAgentRevision: currentRevision,
          newAgentRevision: agentRevision,
          oldMessageRevision: currentMessageRevision,
          newMessageRevision: messageRevision,
          oldModelRevision: currentModelRevision,
          newModelRevision: modelRevision,
          oldPolisherRevision: currentPolisherRevision,
          newPolisherRevision: polisherRevision,
        });
        await current.stop();
      }
      const chatModelId = this.config.chatModel;
      const chat = this.model.resolveChatModel(chatModelId, channel.context);
      const toolChoice = resolveToolChoice(chat);
      if (toolChoice === undefined) {
        this.logger.debug("runtimes.tool_choice_compatible", {
          fullId: chat.fullId,
          provider: chat.providerId,
          model: chat.modelId,
          toolCallCapability: chat.entry.toolCall,
          providerToolCount: Object.keys(chat.tools ?? {}).length,
        });
      }
      const compactModel = this.resolveCompactModel(chat.model, channel.context);
      const vision = this.resolveVision(channel.context);
      const imageProjection = new EphemeralImageProjectionStore();
      const polisher = this.polishers.resolve();
      const polish =
        polisher === undefined
          ? undefined
          : createSendMessagePolisher({
              registry: this.polishers,
              resolveProfile: async () => ({
                persona: await readPersona(this.config.basePath, this.logger),
                ...(await this.polishers.resolveProfile(channel.context)),
              }),
              context: channel.context,
            });
      const willContext: ChannelContext = channel.context.type === "direct" ? channel.context : { ...channel.context, selfId: bot.selfId };
      const runtime = new ChannelRuntime(this.ctx, {
        channel,
        bot,
        will: await this.agents.setupWill(willContext, session),
        model: chat.model,
        toolChoice,
        compactModel,
        providerTools: chat.tools,
        visionModel: vision?.model,
        readImagePolicy: resolveReadImagePolicy(chat, vision, this.config.imageInput),
        imageProjection,
        config: this.config,
        plugins: await this.agents.setup(channel.context, bot, { imageProjection, polisherActive: polisher !== undefined }),
        polisher,
        polish,
        messageBatch: this.messageBatches.select(channel.context),
        archiveMaxBytes: this.config.session.archive.maxKB * 1024,
        ...(this.channels.compactFragments ? { compactFragments: this.channels.compactFragments } : {}),
      });
      try {
        await runtime.init();
      } catch (cause) {
        await runtime.stop().catch(() => undefined);
        throw cause;
      }
      const latestMessageRevision = this.messageBatches.revision;
      if (latestMessageRevision !== messageRevision) {
        this.logger.warn("runtimes.get.message_revision_changed", { key, selectedRevision: messageRevision, latestRevision: latestMessageRevision });
        await runtime.stop();
        retry = true;
        return;
      }
      const latestPolisherRevision = this.polishers.revision;
      if (latestPolisherRevision !== polisherRevision) {
        this.logger.warn("runtimes.get.polisher_revision_changed", { key, selectedRevision: polisherRevision, latestRevision: latestPolisherRevision });
        await runtime.stop();
        retry = true;
        return;
      }
      this.runtimes.set(key, runtime);
      this.agentRevisions.set(key, agentRevision);
      this.messageRevisions.set(key, messageRevision);
      this.modelRevisions.set(key, modelRevision);
      this.polisherRevisions.set(key, polisherRevision);
      this.logger.debug("runtimes.get.created", { key, selfId: bot.selfId, agentRevision, messageRevision, modelRevision, runtimeCount: this.runtimeCount() });
      value = runtime;
    });
    if (retry) return this.get(channel, bot, session);
    return value;
  }

  public async reset(ctx: ChannelContext): Promise<void> {
    const key = runtimeKey(ctx);
    await this.serialize(key, async () => {
      const current = this.runtimes.get(key);
      if (current) {
        this.logger.warn("runtimes.reset", { key });
        await current.stop();
      }
      this.runtimes.delete(key);
      this.agentRevisions.delete(key);
      this.messageRevisions.delete(key);
      this.modelRevisions.delete(key);
      this.polisherRevisions.delete(key);
      await this.channels.reset(ctx);
    });
  }

  public stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true;
    this.logger.debug("runtimes.stop", { runtimeCount: this.runtimes.size });
    this.messageRevisionDisposer();
    this.modelRevisionDisposer();
    this.stopTask = Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.stop())).then(() => {
      this.runtimes.clear();
      this.agentRevisions.clear();
      this.messageRevisions.clear();
      this.modelRevisions.clear();
      this.polisherRevisions.clear();
      this.tails.clear();
    });
    return this.stopTask;
  }

  public async compact(ctx: ChannelContext): Promise<string> {
    const runtime = this.runtimes.get(runtimeKey(ctx));
    if (!runtime) throw new Error("No active Runtime is available to compact this conversation");
    const result = (await runtime.compact("manual")) as { compacted: boolean; reason?: string };
    if (result.compacted) return "已压缩当前会话。";
    if (result.reason === "minimum_messages") return "消息不足，未压缩。";
    if (result.reason === "failure_limit") return "连续压缩失败已达上限，未继续尝试。";
    if (result.reason === "cancelled") return "会话整理已取消。";
    return "会话整理失败，原始历史保持不变。";
  }

  public async archive(ctx: ChannelContext, noSummary = false): Promise<string> {
    const key = runtimeKey(ctx);
    await this.serialize(key, async () => {
      const runtime = this.runtimes.get(key);
      if (runtime) {
        this.logger.warn("runtimes.archive", { key });
        await runtime.stop();
      }
      this.runtimes.delete(key);
      this.agentRevisions.delete(key);
      this.messageRevisions.delete(key);
      this.modelRevisions.delete(key);
      this.polisherRevisions.delete(key);
      const channel = await this.channels.resolve(ctx);
      const chat = noSummary ? undefined : this.model.resolveChatModel(this.config.chatModel, channel.context);
      const input = chat
        ? {
            model: this.resolveCompactModel(chat.model, channel.context),
          }
        : undefined;
      const archiveWithoutSeed = noSummary || !input;
      await channel.conversation.archive(archiveWithoutSeed, input);
    });
    return "已归档当前会话。";
  }

  public clear(ctx: ChannelContext): Promise<void> {
    return this.reset(ctx);
  }

  public async status(ctx: ChannelContext): Promise<string> {
    const conversation = (await this.channels.resolve(ctx)).conversation;
    const active = await conversation.status();
    if (!active.active) return "无会话记录。";
    const entries = await conversation.storage.read();
    const lastCompactIndex = entries.reduce((last, entry, index) => (entry.type === "compact" ? index : last), -1);
    const lastEntry = entries.at(-1);
    const messages = entries.filter((entry) => entry.type === "message").length;
    const compacts = entries.filter((entry) => entry.type === "compact").length;
    const inlineFragments = Math.max(1, Math.floor(this.config.session.compact.inlineFragments ?? 3));
    const messagesSinceLastCompact = entries.slice(lastCompactIndex + 1).filter((entry) => entry.type === "message").length;
    return [
      `活动会话：${active.active.filename}`,
      `消息：${messages}`,
      `压缩：${compacts}`,
      `常驻压缩片段：${Math.min(compacts, inlineFragments)}/${inlineFragments}`,
      `最后活跃：${lastEntry ? new Date(lastEntry.timestamp).toISOString() : "无"}`,
      `自上次压缩以来消息：${messagesSinceLastCompact}`,
      `连续失败：${conversation.failuresCount()}`,
      `文件大小：${formatBytes(active.active.size)}`,
    ].join("\n");
  }

  public async list(ctx: ChannelContext): Promise<string> {
    const sessions = await (await this.channels.resolve(ctx)).conversation.list();
    return sessions.length ? sessions.map((session) => `${session.isActive ? "→ " : "  "}${session.filename}`).join("\n") : "无会话记录。";
  }

  private resolveCompactModel(fallback: LanguageModel, context: ChannelContext): LanguageModel {
    return this.config.session.compact.model ? this.model.resolveChatModel(this.config.session.compact.model, context).model : fallback;
  }

  private resolveVision(context: ChannelContext) {
    const configured = this.config.visionModel?.trim();
    if (!configured) return undefined;
    try {
      const vision = this.model.resolveChatModel(configured, context);
      const imageCapable = vision.entry.modalities?.input?.includes("image") ?? false;
      this.logger.debug("runtimes.vision_model_resolved", {
        route: "vision",
        source: "config.visionModel",
        fullId: vision.fullId,
        provider: vision.providerId,
        model: vision.modelId,
        imageCapable,
      });
      if (imageCapable) return vision;
      this.logger.warn("runtimes.vision_model_not_image_capable", {
        route: "vision",
        source: "config.visionModel",
        fullId: vision.fullId,
      });
      return undefined;
    } catch (cause) {
      const code = cause instanceof AuxiliaryModelError ? cause.code : "unresolvable-model";
      this.logger.warn("runtimes.vision_model_unavailable", {
        route: "vision",
        source: "config.visionModel",
        model: configured,
        code,
      });
      return undefined;
    }
  }

  private async invalidateMessageRuntimes(revision: number): Promise<void> {
    if (this.stopped) return;
    await Promise.all(
      [...this.runtimes.keys()].map((key) =>
        this.serialize(key, async () => {
          const currentRevision = this.messageRevisions.get(key);
          if (currentRevision === undefined || currentRevision >= revision) return;
          const runtime = this.runtimes.get(key);
          if (runtime) {
            this.logger.warn("runtimes.invalidate_message", { key, currentRevision, newRevision: revision });
            await runtime.stop();
          }
          this.runtimes.delete(key);
          this.agentRevisions.delete(key);
          this.messageRevisions.delete(key);
          this.modelRevisions.delete(key);
          this.polisherRevisions.delete(key);
        }),
      ),
    );
  }

  private async invalidateModelRuntimes(revision: number): Promise<void> {
    if (this.stopped) return;
    await Promise.all(
      [...this.runtimes.keys()].map((key) =>
        this.serialize(key, async () => {
          const currentRevision = this.modelRevisions.get(key);
          if (currentRevision === undefined || currentRevision >= revision) return;
          const runtime = this.runtimes.get(key);
          if (runtime) {
            this.logger.warn("runtimes.invalidate_model", { key, currentRevision, newRevision: revision });
            await runtime.stop();
          }
          this.runtimes.delete(key);
          this.agentRevisions.delete(key);
          this.messageRevisions.delete(key);
          this.modelRevisions.delete(key);
          this.polisherRevisions.delete(key);
        }),
      ),
    );
  }

  private async serialize(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    try {
      await next;
    } finally {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    }
  }

  private assertOpen(): void {
    if (this.stopped) throw new Error("Runtimes are stopped");
  }

  private runtimeCount(): number {
    return [...this.runtimes.values()].length;
  }
}

/**
 * Capability gate for provider-side forced tool calling. Only a model whose resolved config
 * explicitly declares `toolCall: true` is forced, and only when no provider-defined tool is mixed
 * in: provider adapters may drop Core function declarations when both are present, and an unknown
 * capability must never be guessed from the provider name. When this returns `undefined` the turn
 * still requires a terminal tool - it just cannot rely on the provider to force one.
 */
export function resolveToolChoice(chat: Pick<ChatModelRef, "entry" | "tools">): "required" | undefined {
  if (chat.entry.toolCall !== true) return undefined;
  if (chat.tools && Object.keys(chat.tools).length > 0) return undefined;
  return "required";
}

export function resolveReadImagePolicy(primary: ChatModelRef, vision: ChatModelRef | undefined, imageInput: boolean): ReadImagePolicy {
  const primaryAcceptsImages = primary.entry.modalities?.input?.includes("image") ?? false;
  if (imageInput && primaryAcceptsImages && primary.capabilities.imageToolResult === "native") {
    return { mode: "native" };
  }

  const visionAcceptsImages = vision?.entry.modalities?.input?.includes("image") ?? false;
  if (vision && visionAcceptsImages) {
    return { mode: "vision", visionModel: vision.model };
  }

  return { mode: "unavailable" };
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  return `${(size / 1024).toFixed(1)} KiB`;
}

function runtimeKey(ctx: ChannelContext): ChannelKey {
  return deriveChannelKey(ctx);
}

export { type RuntimeResult, type PostOptions, ChannelRuntime } from "./channel.js";
