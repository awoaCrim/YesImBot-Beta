import {
  AgentBusyError,
  AgentRequestProjection,
  createAgent,
  createEntry,
  createEventEntry,
  createInternalEvent,
  createSystemMessage,
  EphemeralImageProjectionStore,
  type Agent,
  type AgentEntry,
  type AgentHistoryMode,
  type AgentInternalEvent,
  type AgentPlugin,
  type AgentToolSet,
  type TurnStepEvent,
} from "@yesimbot/agent-runtime";
import type { AssistantContent, LanguageModel, ModelMessage, ToolSet } from "ai";
import { Universal, type Bot, type Context, type Logger } from "koishi";

import type { MainAgentRoleProfile } from "../agents/index.js";
import type { MessagePolisherCapability } from "../agents/polisher.js";
import {
  createDescribeImageTool,
  createExpandCompartmentTool,
  createContextWorkspaceTools,
  createFinishTool,
  createReadTool,
  createSendMessageTool,
  type DeliveredNotice,
  type ReadImagePolicy,
  type SendFailedNotice,
  type SendMessageToolOptions,
} from "../agents/tools.js";
import type { WillBatchDecision, WillEngine, WillReservationOutcome, WillState } from "../agents/will.js";
import { type Channel, type ChannelContext, deriveChannelKey } from "../channels/index.js";
import type { Config } from "../config.js";
import { resolveLatestCompactBoundary } from "../conversations/boundary.js";
import { formatRecalledContinuities } from "../conversations/compact.js";
import type { ContinuityEntry } from "../conversations/context-blocks.js";
import { formatDeliveredTranscriptHistory, isDeliveredTranscript } from "../conversations/delivered-transcript.js";
import {
  COMPACT_FRAGMENT_RECALL_LIMIT,
  formatRecalledFragments,
  formatResidentCompactFragment,
  type CompactFragment,
  type CompactFragmentLineageNode,
  type CompactFragmentRecallSource,
} from "../conversations/fragment-store.js";
import type { CompactInput, CompactReason, CompactResult, Conversation } from "../conversations/index.js";
import { createInternalHistoryProjectionPlugin } from "../conversations/internal-history.js";
import type { MessageBatchController, MessageBatchInput, MessageBatchPlugin } from "../message-batches/index.js";
import {
  createEvent,
  createMessage,
  formatCurrentInput,
  formatCurrentInputWithImages,
  formatInput,
  formatInputWithImages,
  isEvent,
  isMessage,
  isMessageRecord,
  type Event,
  type EventRecord,
  type InputImageResolution,
  type Message,
  type MessageRecord,
} from "../messages/index.js";
import type { HistoryProjectionMode } from "../models/index.js";
import type { ImageFailureCode } from "../resources/image-failure.js";
import { ResourceReadError } from "../resources/index.js";
import { ContextWorkspace } from "./context-workspace.js";
import { buildCoreSystemPrompt } from "./prompt.js";

/** Fixed Core threshold: a provider-reported prompt above this only ever registers a pending compact. */
const PROMPT_LIMIT_INPUT_TOKENS = 150_000;
const CORDIS_ORIGINAL = Symbol.for("cordis.original");

/** Fallback when a config predates the resident-fragment setting. */
const DEFAULT_INLINE_FRAGMENTS = 3;

export type RuntimeResult =
  | { readonly kind: "wait"; readonly eventId: string }
  | { readonly kind: "join"; readonly eventId: string; readonly turnId: string }
  /** `done` settles when the turn finishes; delivery already happened inside `send_message`. */
  | { readonly kind: "run"; readonly eventId: string; readonly done: Promise<void> };

export type PostOptions = {
  readonly trigger?: boolean;
  readonly ifBusy?: "defer" | "join" | "reject";
  readonly delivery?: "channel" | "silent";
  /** Overrides the default event isolation for an explicitly posted turn. */
  readonly historyMode?: AgentHistoryMode;
};

export interface ChannelRuntimeOptions {
  readonly channel: Channel;
  readonly bot: Bot;
  readonly will: WillEngine;
  readonly model: LanguageModel;
  readonly contextModelLimit?: { context: number; output: number };
  readonly resolveContextModelLimit?: (model: LanguageModel) => { context: number; output: number } | undefined;
  /** Provider-scoped request history projection; omitted models use the compatibility default. */
  readonly historyProjection?: HistoryProjectionMode;
  /** Directly projects current-turn persisted images when config and the primary model allow it. */
  readonly directImageInput?: boolean;
  /** Set by the Core capability gate; the Runtime never infers forced tool choice by itself. */
  readonly toolChoice?: "required";
  readonly providerTools?: ToolSet;
  readonly visionModel?: LanguageModel;
  readonly readImagePolicy: ReadImagePolicy;
  readonly imageProjection?: EphemeralImageProjectionStore;
  readonly config: Config;
  readonly plugins: readonly AgentPlugin[];
  /** Resolved once before plugin setup; Core owns its stable prompt placement. */
  readonly roleProfile?: MainAgentRoleProfile;
  readonly messageBatch?: MessageBatchPlugin;
  readonly compactModel?: LanguageModel;
  readonly archiveMaxBytes?: number;
  /** Core persistent overflow index for fragments older than the resident window. */
  readonly compactFragments?: CompactFragmentRecallSource;
  /** Active send-message polisher. Absent means the baseline prompt, schema, and sender are unchanged. */
  readonly polisher?: MessagePolisherCapability;
  /** Resolves the current registered polisher and live profile immediately before sending. */
  readonly polish?: SendMessageToolOptions["polish"];
}

interface CompactionStartOptions {
  readonly force?: boolean;
}

interface TurnDeliveryTracker {
  readonly reservationId?: string;
  turnId?: string;
  delivered: boolean;
  deliveredMessageId?: string;
  settled: boolean;
  settlement?: Promise<void>;
}

interface DirectImageInputOptions {
  readonly resolveImage: (assetId: string, signal?: AbortSignal) => Promise<InputImageResolution>;
}

export class ChannelRuntime {
  public readonly context: ChannelContext;
  public readonly selfId: string;

  private readonly agent: Agent;
  private readonly contextWorkspace?: ContextWorkspace;
  private readonly imageProjection: EphemeralImageProjectionStore;
  private readonly logger: Logger;
  private messageBatchController: MessageBatchController | undefined;
  private readonly pendingBatchInputs = new Map<string, MessageBatchInput>();
  private readonly turnDeliveryTrackers = new Map<string, TurnDeliveryTracker>();
  private tail: Promise<void> = Promise.resolve();
  private readonly streams = new Set<Promise<void>>();
  private stopped = false;
  private stopTask: Promise<void> | undefined;
  private compactionTask: Promise<CompactResult> | undefined;
  private compactionController: AbortController | undefined;
  /** Largest provider-reported prompt size seen since the last consumed compaction trigger. */
  private promptLimitCompact: { readonly inputTokens: number; readonly turnId: string } | undefined;
  /** Turns started by a silent post; `send_message` is blocked for them. */
  private readonly silentTurns = new Set<string>();

  public constructor(
    private readonly ctx: Context,
    private readonly options: ChannelRuntimeOptions,
  ) {
    this.context = options.channel.context;
    this.selfId = options.bot.selfId;
    this.imageProjection = options.imageProjection ?? new EphemeralImageProjectionStore();
    this.logger = ctx.logger("yesimbot/channel-runtime");
    this.logger.level = options.config.logLevel ?? 2;
    const tools: AgentToolSet = [
      createSendMessageTool({
        bot: options.bot,
        channelId: this.context.channelId,
        resources: options.channel.resources,
        pacing: options.config.pacing,
        innerThought: options.config.customInnerThought,
        ...(options.polisher
          ? {
              factsRequired: true,
              ...(options.polish ? { polish: options.polish } : {}),
            }
          : {}),
        onDelivered: (notice) => this.announceDelivered(notice),
        onFailed: (notice) => this.announceSendFailed(notice),
      }),
      createReadTool(options.channel.resources, options.readImagePolicy, this.imageProjection),
      ...(options.config.session.magicContext?.enabled ? [] : [createExpandCompartmentTool(options.channel.conversation)]),
      createFinishTool(),
    ];
    if (options.visionModel && options.readImagePolicy.mode !== "native") {
      tools.push(createDescribeImageTool(options.visionModel, options.channel.resources));
    }
    const channelKey = deriveChannelKey(this.context);
    const projection = options.config.session.magicContext?.enabled ? new AgentRequestProjection() : undefined;
    if (projection) {
      this.contextWorkspace = new ContextWorkspace(options.channel.conversation, projection, {
        config: options.config.session.magicContext!,
        compactMode: options.config.session.compact.mode,
        model: options.model,
        continuityModel: options.compactModel ?? options.model,
        modelLimit: options.contextModelLimit,
        resolveModelLimit: options.resolveContextModelLimit,
        ...(options.historyProjection === "gemini-native" ? { mergeMessages: mergeAdjacentUserMessages } : {}),
        onDiagnostic: (metadata) => {
          const failed =
            metadata.event === "historian.failed" ||
            metadata.event === "maintenance.failed" ||
            (metadata.event === "guard.estimate" && ["safety-deadline", "unresolved-unsafe", "mandatory-overflow"].includes(String(metadata.reason)));
          if (failed) this.logger.warn("runtime.context_budget", metadata);
          else this.logger.debug("runtime.context_budget", metadata);
        },
        onBackgroundSettled: () => this.scheduleArchiveCheck(),
      });
      tools.push(...createContextWorkspaceTools(this.contextWorkspace));
    }
    this.agent = createAgent({
      id: channelKey,
      model: options.model,
      maxRetries: options.config.modelRetries,
      ...(this.contextWorkspace
        ? {
            requestProjection: projection,
            beforeModelRequest: async (context) => {
              const messages = await this.contextWorkspace!.guard(context);
              if (context.historyMode !== "event") return messages;
              return {
                messages,
                activeTools: Object.keys(context.tools).filter((name) => !name.startsWith("ctx_")),
              };
            },
            maxOutputTokens: (model) => this.contextWorkspace!.outputLimit(model),
            onModelUsage: ({ turnId, stepNumber, inputTokens }) => this.contextWorkspace!.observeUsage(turnId, stepNumber, inputTokens),
          }
        : {}),
      // Every Core turn must end on a terminal tool: `finish` for silence, `send_message` for
      // platform output. Plain assistant text is internal reasoning and never a reply.
      requireTerminalTool: true,
      ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
      storage: options.channel.conversation.storage,
      systemPrompt: () =>
        buildCoreSystemPrompt({
          basePath: options.config.basePath,
          channel: this.context,
          selfId: this.selfId,
          customInnerThought: options.config.customInnerThought,
          delegated: options.polisher !== undefined,
          roleProfile: options.roleProfile,
          logger: this.logger,
        }),
      tools,
      providerTools: options.providerTools,
      plugins: [
        // Capture compact anchors from canonical entries before the history projection replaces
        // compact records with request-only system messages.
        ...(this.contextWorkspace
          ? [
              {
                name: "core.context-workspace",
                enforce: "pre" as const,
                transformEntries: (entries: readonly AgentEntry[]) => {
                  this.contextWorkspace!.capture(entries);
                },
                onTurnFinish: (result: import("@yesimbot/agent-runtime").TurnResult) => {
                  this.contextWorkspace!.finish(result);
                },
              },
            ]
          : []),
        // Read-only legacy compact/continuity compatibility; this never schedules compaction.
        this.compactRecallPlugin(channelKey),
        createSummaryHistoryPlugin(inlineFragmentCount(options.config), projection, this.contextWorkspace ? undefined : options.channel.conversation),
        createInternalHistoryProjectionPlugin(options.historyProjection ?? "default", projection),
        createModelInputPlugin(
          options.historyProjection ?? "default",
          this.contextWorkspace !== undefined,
          options.directImageInput
            ? {
                resolveImage: (assetId, signal) => this.resolveInputImage(assetId, signal),
              }
            : undefined,
        ),
        this.imageProjectionPlugin(),
        this.silentTurnPlugin(),
        ...options.plugins,
      ],
    });
  }

  public isBoundTo(bot: Bot): boolean {
    // Cordis may create a new scoped proxy for the same Bot on each lookup.
    return canonicalBotIdentity(this.options.bot) === canonicalBotIdentity(bot) && this.selfId === bot.selfId;
  }

  public async init(): Promise<void> {
    await this.agent.init();
    if (this.stopped) return;

    const plugin = this.options.messageBatch;
    if (plugin) {
      const controller = await plugin.setup(this.context, (messages) => this.flushBatch(messages), {
        flushInputs: (inputs) => this.flushBatch(inputs),
      });
      if (this.stopped) {
        await controller.stop?.();
        return;
      }
      this.messageBatchController = controller;
    }
  }

  public handle(record: MessageRecord | EventRecord): Promise<RuntimeResult> {
    return this.schedule(async () => {
      this.assertOpen();
      const input = await this.commit(record);
      if (this.messageBatchController && this.enqueueBatchInput(input)) {
        this.logger.debug("runtime.handle", {
          eventId: input.id,
          eventType: isMessage(input) ? "message" : "event",
          decision: "batched",
          result: "wait",
          activeTurnId: this.state().activeTurnId,
        });
        return { kind: "wait" as const, eventId: input.id };
      }
      if (this.options.will.decideBatch) {
        const batchDecision = await this.decideBatch([input]);
        const result = batchDecision.decision === "wait" ? { kind: "wait" as const, eventId: input.id } : await this.startBatchDecision(input, batchDecision);
        this.logger.debug("runtime.handle", {
          eventId: input.id,
          eventType: isMessage(input) ? "message" : "event",
          decision: batchDecision.decision,
          result: result.kind,
          activeTurnId: this.state().activeTurnId,
        });
        return result;
      }
      const decision = await this.decide(input);
      const busyBehavior = this.context.type === "direct" ? "join" : "defer";
      const result = decision === "wait" ? { kind: "wait" as const, eventId: input.id } : this.start(input, true, busyBehavior);
      this.logger.debug("runtime.handle", {
        eventId: input.id,
        eventType: isMessage(input) ? "message" : "event",
        decision,
        result: result.kind,
        activeTurnId: this.state().activeTurnId,
      });
      return result;
    });
  }

  public post(event: EventRecord, options: PostOptions = {}): Promise<RuntimeResult> {
    const trigger = options.trigger ?? true;
    const ifBusy = options.ifBusy ?? "defer";
    return this.schedule(async () => {
      this.assertOpen();
      if (trigger && ifBusy === "reject" && this.agent.getActiveTurnId() !== null) throw new AgentBusyError();
      const input = await this.persist(event);
      await this.archiveIfOversize();
      const silent = options.delivery === "silent";
      const result = !trigger ? { kind: "wait" as const, eventId: input.id } : this.start(input, false, ifBusy, silent, undefined, options.historyMode);
      this.logger.debug("runtime.post", { eventId: input.id, eventType: event.eventType, trigger, ifBusy, silent, result: result.kind });
      return result;
    });
  }

  public wait(): Promise<void> {
    return this.agent.wait();
  }

  public compact(reason: CompactReason): Promise<unknown> {
    return this.startCompaction(reason);
  }

  private startCompaction(reason: CompactReason, options: CompactionStartOptions = {}): Promise<CompactResult> {
    return this.createCompactionTask(reason, options, true).task;
  }

  /** The inbound FIFO task must run compaction inline; scheduling it again would self-deadlock. */
  private startCompactionInline(
    reason: CompactReason,
    options: CompactionStartOptions = {},
  ): { readonly started: boolean; readonly task: Promise<CompactResult> } {
    return this.createCompactionTask(reason, options, false);
  }

  private createCompactionTask(
    reason: CompactReason,
    options: CompactionStartOptions,
    scheduled: boolean,
  ): { readonly started: boolean; readonly task: Promise<CompactResult> } {
    if (this.contextWorkspace) return { started: false, task: Promise.resolve({ compacted: false, reason: "magic_context_managed" }) };
    if (this.compactionTask) return { started: false, task: this.compactionTask };

    const controller = new AbortController();
    this.compactionController = controller;
    const operation = async (): Promise<CompactResult> => {
      if (this.stopped) return { compacted: false, reason: "stopped" };
      if (!this.agent.isIdle()) return { compacted: false, reason: "busy" };

      const input: CompactInput = {
        model: this.options.compactModel ?? this.options.model,
        signal: controller.signal,
        ...(options.force ? { force: true } : {}),
      };
      const result = await this.options.channel.conversation.compact(reason, input);
      if (result.compacted) {
        const pending = this.promptLimitCompact;
        if (pending) {
          this.promptLimitCompact = undefined;
          this.logger.debug("runtime.compact_prompt_limit_skip", {
            reason: "covered_by_compaction",
            turnId: pending.turnId,
            inputTokens: pending.inputTokens,
          });
        }
        if (this.agent.isIdle()) await this.archiveIfOversize();
      }
      return result;
    };
    const task = scheduled ? this.schedule(operation) : Promise.resolve().then(operation);
    this.compactionTask = task;
    const cleanup = () => {
      if (this.compactionTask === task) this.compactionTask = undefined;
      if (this.compactionController === controller) this.compactionController = undefined;
    };
    void task.then(cleanup, cleanup);
    return { started: true, task };
  }

  public stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.contextWorkspace?.stop();
    this.logger.warn("runtime.stop_requested", {
      platform: this.context.platform,
      channelId: this.context.channelId,
      selfId: this.selfId,
      activeTurnId: this.agent.getActiveTurnId(),
      reason: "stop",
    });
    this.stopped = true;
    const batchController = this.messageBatchController;
    this.messageBatchController = undefined;
    this.pendingBatchInputs.clear();
    const compactionTask = this.compactionTask;
    this.compactionController?.abort("stop");
    this.stopTask = Promise.resolve(batchController?.stop?.())
      .catch((cause) => this.logger.warn("runtime.message_batch_stop_failed", { cause }))
      .then(() =>
        this.schedule(async () => {
          await this.agent.interrupt("stop");
          await this.agent.stop();
          await Promise.allSettled([...this.streams]);
          await Promise.allSettled(compactionTask ? [compactionTask] : []);
        }),
      );
    return this.stopTask;
  }

  private async persist(record: MessageRecord | EventRecord): Promise<Message | Event> {
    const input = isMessageRecord(record) ? createMessage(record) : createEvent(record);
    await this.agent.append(input);
    this.ctx.emit(isMessage(input) ? "yesimbot/message" : "yesimbot/event", input as never);
    return input;
  }

  private async commit(record: MessageRecord | EventRecord): Promise<Message | Event> {
    const input = await this.persist(record);
    await this.archiveIfOversize();
    return input;
  }

  private enqueueBatchInput(input: MessageBatchInput): boolean {
    const controller = this.messageBatchController;
    if (!controller) return false;
    if (!isMessage(input) && (!this.options.will.decideBatch || !controller.enqueueEvent)) return false;
    this.pendingBatchInputs.set(input.id, input);
    try {
      if (isMessage(input)) {
        controller.enqueue(input);
        return true;
      }
      const accepted = controller.enqueueEvent!(input);
      if (!accepted) this.pendingBatchInputs.delete(input.id);
      return accepted;
    } catch (cause) {
      this.pendingBatchInputs.delete(input.id);
      throw cause;
    }
  }

  private async decide(input: Message | Event): Promise<"wait" | "trigger"> {
    const decision = await this.options.will.decide(input, this.state());
    await this.persistWillDecision(input.id, decision);
    return decision;
  }

  private async decideBatch(inputs: readonly MessageBatchInput[]): Promise<WillBatchDecision> {
    const decision = await this.options.will.decideBatch!(inputs, this.state());
    await this.persistWillDecision(inputs.at(-1)!.id, decision.decision, {
      candidate: decision.candidate,
      reservationId: decision.reservationId,
    });
    return decision;
  }

  private async persistWillDecision(eventId: string, decision: "wait" | "trigger", batch?: Record<string, unknown>): Promise<void> {
    try {
      const debug = this.options.will.debug?.();
      await this.options.channel.conversation.storage.append(
        createEventEntry(createInternalEvent({ type: "will.decision", eventId, decision, debug: batch ? { ...debug, batch } : debug })),
      );
    } catch (cause) {
      this.logger.warn("runtime.will_decision_persist_failed", { eventId, cause });
    }
  }

  private flushBatch(inputs: readonly MessageBatchInput[]): Promise<void> {
    const snapshot = [...inputs];
    if (snapshot.length === 0) return Promise.resolve();
    return this.schedule(async () => {
      if (this.stopped) return;
      const pending: MessageBatchInput[] = [];
      for (const input of snapshot) {
        if (this.pendingBatchInputs.get(input.id) !== input) continue;
        this.pendingBatchInputs.delete(input.id);
        pending.push(input);
      }
      if (pending.length === 0) return;
      const latest = pending.at(-1)!;

      if (this.options.will.decideBatch) {
        let decision: WillBatchDecision;
        try {
          decision = await this.decideBatch(pending);
        } catch (cause) {
          this.logger.warn("runtime.message_batch_will_failed", { eventId: latest.id, cause });
          return;
        }
        if (decision.decision === "wait") {
          this.logger.debug("runtime.message_batch_flush", { size: pending.length, trigger: false, latestEventId: latest.id });
          return;
        }
        if (this.stopped) {
          if (decision.reservationId) {
            await this.settleReservationWithRetry(decision.reservationId, { kind: "release", reason: "start-failed" }).catch((cause) => {
              this.logger.warn("runtime.will_reservation_settlement_failed", { reservationId: decision.reservationId, cause });
            });
          }
          return;
        }
        const result = await this.startBatchDecision(latest, decision);
        this.logger.debug("runtime.message_batch_flush", {
          size: pending.length,
          trigger: true,
          latestEventId: latest.id,
          candidate: decision.candidate,
          reservationId: decision.reservationId,
          result: result.kind,
          activeTurnId: this.state().activeTurnId,
        });
        return;
      }

      let trigger = false;
      for (const input of pending) {
        if (this.stopped) return;
        let decision: "wait" | "trigger";
        try {
          decision = await this.decide(input);
        } catch (cause) {
          this.logger.warn("runtime.message_batch_will_failed", { eventId: input.id, cause });
          continue;
        }
        if (this.stopped) return;
        if (decision === "trigger") trigger = true;
      }
      if (!trigger || this.stopped) {
        this.logger.debug("runtime.message_batch_flush", { size: pending.length, trigger: false, latestEventId: latest.id });
        return;
      }
      const result = this.start(latest, true, "defer");
      this.logger.debug("runtime.message_batch_flush", {
        size: pending.length,
        trigger: true,
        latestEventId: latest.id,
        result: result.kind,
        activeTurnId: this.state().activeTurnId,
      });
    });
  }

  private async startBatchDecision(input: MessageBatchInput, decision: WillBatchDecision): Promise<RuntimeResult> {
    try {
      return this.start(input, true, "defer", false, decision.reservationId);
    } catch (cause) {
      if (decision.reservationId) {
        await this.settleReservationWithRetry(decision.reservationId, { kind: "release", reason: "start-failed" }).catch(() => undefined);
      }
      throw cause;
    }
  }

  private announceDelivered(notice: DeliveredNotice): void {
    if (notice.channelId !== this.context.channelId || !notice.messageId) return;
    const tracker = this.turnDeliveryTrackers.get(notice.turnId);
    if (tracker && !tracker.delivered) {
      tracker.delivered = true;
      tracker.deliveredMessageId = notice.messageId;
      if (tracker.reservationId) {
        const settlement = this.settleTracker(tracker, {
          kind: "commit",
          turnId: notice.turnId,
          messageId: notice.messageId,
        });
        void settlement.catch(() => undefined);
      }
    }
    this.ctx.emit("yesimbot/delivered", {
      platform: this.context.platform,
      selfId: this.selfId,
      channel: { id: this.context.channelId, type: this.channelType() },
      messageId: notice.messageId,
      turnId: notice.turnId,
      text: notice.text,
    });
  }

  /** Surfaces send failures to operators; the model already received them as the tool result. */
  private announceSendFailed(notice: SendFailedNotice): void {
    this.ctx.emit(
      "yesimbot/event",
      createEvent({
        eventType: "delivery.failed",
        platform: this.context.platform,
        selfId: this.selfId,
        channel: { id: notice.channelId, type: this.channelType() },
        timestamp: Date.now(),
        text: "delivery failed",
        delivery: {
          turnId: notice.turnId,
          messageId: "",
          segmentIndex: notice.failedAt + 1,
          segmentTotal: notice.total,
          error: notice.error,
        },
      }),
    );
  }

  private channelType(): Universal.Channel["type"] {
    return this.context.type === "direct" ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT;
  }

  private start(
    input: Message | Event,
    passive: boolean,
    ifBusy: "defer" | "join" | "reject",
    silent = false,
    reservationId?: string,
    historyMode?: AgentHistoryMode,
  ): RuntimeResult {
    const activeTurnId = this.agent.getActiveTurnId();
    if (ifBusy === "join" && activeTurnId !== null) {
      this.agent.send(input, { ifBusy: "join" });
      return { kind: "join", eventId: input.id, turnId: activeTurnId };
    }
    const tracker: TurnDeliveryTracker = { delivered: false, settled: false, ...(reservationId ? { reservationId } : {}) };
    const stream = this.agent.run(input, {
      ifBusy: ifBusy === "join" ? "defer" : ifBusy,
      historyMode: historyMode ?? (isEvent(input) ? "event" : "conversation"),
    });
    const task = this.consume(stream, passive, silent, tracker);
    this.streams.add(task);
    void task.finally(() => this.streams.delete(task));
    return { kind: "run", eventId: input.id, done: task };
  }

  private async consume(stream: AsyncIterable<AgentInternalEvent>, passive: boolean, silent: boolean, tracker: TurnDeliveryTracker): Promise<void> {
    let consumeFailed = false;
    let terminal: "done" | "failed" | "aborted" | undefined;
    let turnId = "";
    try {
      for await (const event of stream) {
        if ("turnId" in event) {
          this.bindTurnTracker(tracker, event.turnId);
          turnId = tracker.turnId ?? turnId;
        }
        if (event.type === "turn.queued") continue;
        if (event.type === "turn.start") {
          if (silent) this.silentTurns.add(event.turnId);
          this.logger.debug("runtime.turn.start", { turnId: event.turnId, silent });
          continue;
        }
        if (event.type === "turn.step") {
          this.logger.debug("runtime.turn.step", {
            turnId: event.turnId,
            stepNumber: event.step,
            finishReason: event.finishReason,
            usage: event.usage,
            reasoningText: event.reasoningText === undefined ? undefined : event.reasoningText.slice(0, 1000),
          });
          this.observePromptUsage(event);
          continue;
        }
        if (event.type === "turn.done") {
          terminal = "done";
          this.logger.debug("runtime.turn.done", { turnId: event.turnId });
          continue;
        }
        if (event.type === "tool.start") {
          this.logger.debug("runtime.tool.start", { turnId: event.turnId, toolName: event.toolName, toolCallId: event.toolCallId });
          continue;
        }
        if (event.type === "tool.done") {
          this.logger.debug("runtime.tool.done", { turnId: event.turnId, toolName: event.toolName, toolCallId: event.toolCallId });
          continue;
        }
        if (event.type === "tool.failed") {
          this.logger.warn("runtime.tool.failed", { turnId: event.turnId, toolName: event.toolName, toolCallId: event.toolCallId, error: event.error.message });
          continue;
        }
        if (event.type === "message.appended" && "turnId" in event && event.message.role === "assistant") {
          // Model text is internal reasoning space: it is recorded and logged, never delivered.
          const content = renderAssistantText(event.message.content);
          if (content !== undefined) {
            this.logger.debug("runtime.output.text", { turnId, messageId: event.message.id, text: content.slice(0, 2000) });
          }
          continue;
        }
        if (event.type === "turn.failed") {
          terminal = "failed";
          this.logger.warn("runtime.turn.failed", { turnId: event.turnId, error: event.error.message });
          break;
        }
        if (event.type === "turn.aborted") {
          terminal = "aborted";
          this.logger.warn("runtime.turn.aborted", { turnId: event.turnId, reason: event.reason });
          break;
        }
      }
      if (terminal !== "failed" && terminal !== "aborted") {
        terminal = "done";
        if (passive) await this.options.will.observe?.({ turnId, status: "done", messages: [] });
      }
    } catch (cause) {
      consumeFailed = true;
      this.logger.warn("runtime.turn.consume_failed", { turnId, cause });
    } finally {
      if (tracker.reservationId) {
        const outcome: WillReservationOutcome =
          tracker.delivered && tracker.turnId && tracker.deliveredMessageId
            ? { kind: "commit", turnId: tracker.turnId, messageId: tracker.deliveredMessageId }
            : {
                kind: "release",
                ...(tracker.turnId ? { turnId: tracker.turnId } : {}),
                reason: consumeFailed ? "consume-failed" : terminal === "failed" ? "failed" : terminal === "aborted" ? "aborted" : "done-without-delivery",
              };
        await this.settleTrackerAtTerminal(tracker, outcome).catch((cause) => {
          this.logger.warn("runtime.will_reservation_settlement_failed", { reservationId: tracker.reservationId, outcome, cause });
        });
      }
      if (tracker.turnId) {
        this.silentTurns.delete(tracker.turnId);
        if (this.turnDeliveryTrackers.get(tracker.turnId) === tracker) this.turnDeliveryTrackers.delete(tracker.turnId);
      }
      this.schedulePromptLimitCompact();
      this.scheduleArchiveCheck();
    }
  }

  private bindTurnTracker(tracker: TurnDeliveryTracker, turnId: string): void {
    if (tracker.turnId && tracker.turnId !== turnId) {
      this.logger.warn("runtime.will_reservation_turn_mismatch", {
        expectedTurnId: tracker.turnId,
        actualTurnId: turnId,
        reservationId: tracker.reservationId,
      });
      return;
    }
    const existing = this.turnDeliveryTrackers.get(turnId);
    if (existing && existing !== tracker) {
      this.logger.warn("runtime.delivery_tracker_collision", { turnId, reservationId: tracker.reservationId });
      return;
    }
    tracker.turnId = turnId;
    this.turnDeliveryTrackers.set(turnId, tracker);
  }

  private settleTracker(tracker: TurnDeliveryTracker, outcome: WillReservationOutcome): Promise<void> {
    if (!tracker.reservationId || tracker.settled) return Promise.resolve();
    if (tracker.settlement) return tracker.settlement;
    const settlement = this.settleReservationWithRetry(tracker.reservationId, outcome).then(() => {
      tracker.settled = true;
    });
    let tracked!: Promise<void>;
    tracked = settlement.finally(() => {
      if (tracker.settlement === tracked) tracker.settlement = undefined;
    });
    tracker.settlement = tracked;
    return tracked;
  }

  private async settleTrackerAtTerminal(tracker: TurnDeliveryTracker, outcome: WillReservationOutcome): Promise<void> {
    const active = tracker.settlement;
    if (active) await active.catch(() => undefined);
    if (!tracker.settled) await this.settleTracker(tracker, outcome);
  }

  private async settleReservationWithRetry(reservationId: string, outcome: WillReservationOutcome): Promise<void> {
    const settle = this.options.will.settleReservation;
    if (!settle) throw new Error("WillEngine returned a reservation without settlement support");
    let failure: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await settle.call(this.options.will, reservationId, outcome);
        return;
      } catch (cause) {
        failure = cause;
        this.logger.warn("runtime.will_reservation_settlement_retry", { reservationId, outcome, attempt, cause });
        await Promise.resolve();
      }
    }
    throw failure;
  }

  private state(): WillState {
    return { activeTurnId: this.agent.getActiveTurnId() };
  }

  private schedule<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertOpen(): void {
    if (this.stopped) throw new Error("Channel runtime is stopped");
  }

  /** Provider-reported prompt size is the only automatic compaction trigger. */
  private observePromptUsage(event: TurnStepEvent): void {
    const inputTokens = event.usage?.inputTokens;
    if (this.contextWorkspace) return; // Direct main-model callback owns Magic usage and scheduling.
    if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens <= PROMPT_LIMIT_INPUT_TOKENS) return;
    if (this.promptLimitCompact && this.promptLimitCompact.inputTokens >= inputTokens) return;

    this.promptLimitCompact = { inputTokens, turnId: event.turnId };
    this.logger.warn("runtime.compact_prompt_limit_pending", {
      turnId: event.turnId,
      step: event.step,
      inputTokens,
      threshold: PROMPT_LIMIT_INPUT_TOKENS,
    });
  }

  /** Wait outside the runtime FIFO so an active Agent turn or tool continuation is never cut short. */
  private schedulePromptLimitCompact(): void {
    if (this.stopped || !this.promptLimitCompact) return;
    void this.agent.wait().then(
      () => {
        if (this.stopped) return;
        void this.schedule(async () => {
          if (this.stopped) return;
          await this.runPromptLimitCompact();
        });
      },
      (cause) => {
        this.logger.warn("runtime.compact_prompt_limit_wait_failed", {
          errorName: cause instanceof Error ? cause.name : typeof cause,
        });
      },
    );
  }

  private async runPromptLimitCompact(): Promise<void> {
    const pending = this.promptLimitCompact;
    if (!pending || this.stopped) return;
    if (!this.agent.isIdle()) {
      // A turn admitted while this task waited owns the Agent again; its own idle check retries.
      return;
    }

    const activeCompaction = this.compactionTask;
    if (activeCompaction) {
      void activeCompaction.then(
        (result) => {
          if (this.stopped) return;
          if (result.compacted) {
            if (this.promptLimitCompact === pending) this.promptLimitCompact = undefined;
            this.logger.debug("runtime.compact_prompt_limit_skip", {
              reason: "compaction_in_flight",
              turnId: pending.turnId,
              inputTokens: pending.inputTokens,
            });
            return;
          }
          this.schedulePromptLimitCompact();
        },
        (cause) => {
          if (this.stopped) return;
          this.logger.warn("runtime.compact_prompt_limit_existing_failed", {
            turnId: pending.turnId,
            errorName: cause instanceof Error ? cause.name : typeof cause,
          });
          this.schedulePromptLimitCompact();
        },
      );
      return;
    }

    // One provider response funds at most one attempt: a later oversized request can re-register.
    this.promptLimitCompact = undefined;
    const { started, task } = this.startCompactionInline("prompt-limit", { force: true });
    if (!started) {
      this.logger.debug("runtime.compact_prompt_limit_skip", {
        reason: "compaction_in_flight",
        turnId: pending.turnId,
        inputTokens: pending.inputTokens,
      });
      return;
    }

    try {
      const result = await task;
      this.logger.debug("runtime.compact_prompt_limit_result", {
        turnId: pending.turnId,
        inputTokens: pending.inputTokens,
        threshold: PROMPT_LIMIT_INPUT_TOKENS,
        compacted: result.compacted,
        reason: result.reason,
      });
    } catch (cause) {
      this.logger.warn("runtime.compact_prompt_limit_failed", {
        turnId: pending.turnId,
        inputTokens: pending.inputTokens,
        threshold: PROMPT_LIMIT_INPUT_TOKENS,
        errorName: cause instanceof Error ? cause.name : typeof cause,
      });
    }
  }

  private scheduleArchiveCheck(): void {
    if (this.stopped || (this.options.archiveMaxBytes ?? 0) <= 0) return;
    void this.schedule(async () => {
      if (this.stopped || this.agent.getActiveTurnId() !== null) return;
      await this.archiveIfOversize();
    }).catch(() => this.logger.warn("runtime.archive_check_failed", { reason: "archive_failed" }));
  }

  private async archiveIfOversize(): Promise<void> {
    const maxBytes = this.options.archiveMaxBytes ?? 0;
    if (this.stopped || maxBytes <= 0 || this.contextWorkspace?.status().backgroundActive) return;
    if (!this.options.compactModel) {
      await this.options.channel.conversation.archiveIfOversize(maxBytes);
      return;
    }
    await this.options.channel.conversation.archiveIfOversize(maxBytes, {
      model: this.options.compactModel,
    });
  }

  private async resolveInputImage(assetId: string, signal?: AbortSignal): Promise<InputImageResolution> {
    try {
      const opened = await this.options.channel.resources.openStrict(`asset://${assetId}`, signal);
      const mediaType = this.options.channel.resources.detectImageMediaType(opened.bytes);
      return mediaType ? { bytes: opened.bytes, mediaType } : { error: "not_image" };
    } catch (cause) {
      if (!(cause instanceof ResourceReadError)) return { error: "resource_unavailable" };
      const error: ImageFailureCode =
        cause.code === "resource_not_found"
          ? "resource_missing"
          : cause.code === "timeout"
            ? "timeout"
            : cause.code === "resource_too_large"
              ? "too_large"
              : cause.code === "resource_read_aborted"
                ? "resource_aborted"
                : cause.code === "resource_unavailable"
                  ? "resource_unavailable"
                  : "download_failed";
      return { error };
    }
  }

  private imageProjectionPlugin(): AgentPlugin {
    return {
      name: "core.image-projection",
      onTurnFinish: (_result, context) => this.imageProjection.clearTurn(context.turnId),
      stop: () => this.imageProjection.clearAll(),
    };
  }

  /**
   * Bounded recall of fragments older than the resident window. It reads the current request from
   * the built model messages, prepends one read-only system block, and never mutates JSONL or the
   * current turn. Any store failure only skips recall; the model request still proceeds.
   */
  private compactRecallPlugin(channelKey: string): AgentPlugin {
    let residentIds: ReadonlySet<string> = new Set<string>();
    let lineageId: string | undefined;
    let before: number | undefined;
    let anchor: CompactFragmentLineageNode | undefined;
    let knownFragments: CompactFragmentLineageNode[] = [];
    let captured = false;
    const recalls = new Map<
      string,
      { query: string; lineageId: string; anchorId: string; before: number; fragments: CompactFragment[]; continuities: ContinuityEntry[] }
    >();
    return {
      name: "core.compact-recall",
      enforce: "pre",
      transformEntries: (entries) => {
        const compacts = entries.filter((entry): entry is Extract<AgentEntry, { type: "compact" }> => entry.type === "compact");
        const inline = inlineFragmentCount(this.options.config);
        residentIds = new Set(compacts.slice(-inline).map((entry) => entry.id));
        knownFragments = compacts.map((entry) => ({ id: entry.id, ...(entry.data.parentCompactId ? { parentCompactId: entry.data.parentCompactId } : {}) }));
        const latest = compacts.at(-1);
        lineageId = latest ? (latest.data.lineageId ?? latest.id) : undefined;
        before = latest ? (latest.data.endAt ?? latest.timestamp) : undefined;
        anchor = latest ? { id: latest.id, ...(latest.data.parentCompactId ? { parentCompactId: latest.data.parentCompactId } : {}) } : undefined;
        captured = true;
        return undefined;
      },
      prepareStep: async (messages, context) => {
        // `transformEntries` only runs for persisted-history projections. When it did not run
        // (for example an event-only history mode) there is no captured lineage, so skip recall.
        if (!captured) return undefined;
        captured = false;
        const source = this.options.compactFragments;
        const current = lineageId && anchor && before !== undefined ? { lineageId, anchor, before } : undefined;
        if (!current) return undefined;

        const previous = recalls.get(context.turnId);
        const requestQuery = extractCurrentMessageQuery(messages);
        const query = requestQuery ?? (previous?.lineageId === current.lineageId && previous.anchorId === current.anchor.id ? previous.query : undefined);
        if (!query) return undefined;

        let fragments: CompactFragment[];
        let continuities: ContinuityEntry[];
        if (
          previous?.query === query &&
          previous.lineageId === current.lineageId &&
          previous.anchorId === current.anchor.id &&
          previous.before === current.before
        ) {
          fragments = previous.fragments;
          continuities = previous.continuities;
        } else {
          fragments = [];
          continuities = [];
          if (source) {
            try {
              const candidates = await source.recall({
                channelKey,
                lineageId: current.lineageId,
                query,
                anchor: current.anchor,
                knownFragments,
                before: current.before,
                excludeIds: residentIds,
                limit: COMPACT_FRAGMENT_RECALL_LIMIT,
              });
              const seen = new Set<string>();
              for (const fragment of candidates) {
                if (residentIds.has(fragment.id) || (fragment.endAt ?? fragment.createdAt) > current.before || seen.has(fragment.id)) continue;
                seen.add(fragment.id);
                fragments.push(fragment);
                if (fragments.length >= COMPACT_FRAGMENT_RECALL_LIMIT) break;
              }
            } catch (cause) {
              this.logger.warn("runtime.compact_recall_failed", { errorName: cause instanceof Error ? cause.name : typeof cause });
            }
          }
          try {
            const remaining = Math.max(0, COMPACT_FRAGMENT_RECALL_LIMIT - fragments.length);
            if (remaining > 0) {
              continuities = [
                ...(await this.options.channel.conversation.recallContinuity({
                  lineageId: current.lineageId,
                  query,
                  before: current.before,
                  excludeIds: new Set([...residentIds, ...fragments.map((fragment) => fragment.id)]),
                  limit: remaining,
                })),
              ];
            }
          } catch (cause) {
            this.logger.warn("runtime.continuity_recall_failed", { errorName: cause instanceof Error ? cause.name : typeof cause });
          }
          recalls.set(context.turnId, {
            query,
            lineageId: current.lineageId,
            anchorId: current.anchor.id,
            before: current.before,
            fragments,
            continuities,
          });
        }

        if (fragments.length === 0 && continuities.length === 0) return undefined;
        this.logger.debug("runtime.compact_recall", { count: fragments.length + continuities.length, lineageId: current.lineageId });
        const recalled: ModelMessage = {
          role: "system",
          content: [
            ...(fragments.length ? [formatRecalledFragments(fragments)] : []),
            ...(continuities.length ? [formatRecalledContinuities(continuities)] : []),
          ].join("\n"),
        };
        context.projection?.register(recalled, {
          kind: "recall",
          sourceEntryIds: [...fragments.map((fragment) => fragment.id), ...continuities.map((entry) => entry.id)],
          timestamp: 0,
        });
        return [recalled, ...messages];
      },
      onTurnFinish: (_result, context) => {
        recalls.delete(context.turnId);
        captured = false;
      },
      stop: () => {
        recalls.clear();
        captured = false;
      },
    };
  }

  /** Silent posts must not reach the channel, so `send_message` is refused for their turns. */
  private silentTurnPlugin(): AgentPlugin {
    return {
      name: "core.silent-turn",
      beforeToolCall: (call, context) =>
        call.toolName === "send_message" && this.silentTurns.has(context.turnId)
          ? { type: "block", reason: "本轮是静默后台任务，不能向频道发送消息。完成任务后调用 finish 结束本轮。" }
          : { type: "allow" },
    };
  }
}

export function createModelInputPlugin(mode: HistoryProjectionMode = "default", deferMerge = false, directImageInput?: DirectImageInputOptions): AgentPlugin {
  return {
    name: "core.model-input",
    enforce: "pre",
    toModelMessages: async (message, context) => {
      if (isDeliveredTranscript(message)) {
        if (mode === "gemini-native") return [];
        // Magic must select bounded canonical source units before any cross-source merge.
        const transcripts = deferMerge ? [message] : context.history.filter(isDeliveredTranscript);
        if (transcripts[0]?.id !== message.id) return [];
        const output = formatDeliveredTranscriptHistory(transcripts);
        context.projection?.inherit(output, transcripts);
        return [output];
      }
      if (!isMessage(message) && !isEvent(message)) return [];
      const isCurrent = context.current.some((current) => current.id === message.id);
      const isLive = directImageInput !== undefined && context.live?.some((live) => live.id === message.id) === true;
      if (directImageInput && (isCurrent || isLive)) {
        const resolve = (assetId: string) => directImageInput.resolveImage(assetId, context.signal);
        return [isCurrent ? await formatCurrentInputWithImages(message, resolve) : await formatInputWithImages(message, resolve)];
      }
      return [isCurrent ? formatCurrentInput(message) : formatInput(message)];
    },
    ...(mode === "gemini-native" && !deferMerge ? { prepareStep: (messages: readonly ModelMessage[]) => mergeAdjacentUserMessages(messages) } : {}),
  };
}

export function mergeAdjacentUserMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  for (const message of messages) {
    const previous = result.at(-1);
    if (previous?.role === "user" && message.role === "user") {
      result[result.length - 1] = mergeUserMessages(previous, message);
    } else {
      result.push(message);
    }
  }
  return result;
}

function mergeUserMessages(
  first: Extract<ModelMessage, { role: "user" }>,
  second: Extract<ModelMessage, { role: "user" }>,
): Extract<ModelMessage, { role: "user" }> {
  const providerOptions =
    first.providerOptions && second.providerOptions
      ? { ...first.providerOptions, ...second.providerOptions }
      : (first.providerOptions ?? second.providerOptions);
  return {
    ...first,
    content: mergeUserContent(first.content, second.content),
    ...(providerOptions === undefined ? {} : { providerOptions }),
  };
}

function mergeUserContent(first: Extract<ModelMessage, { role: "user" }>["content"], second: Extract<ModelMessage, { role: "user" }>["content"]) {
  if (typeof first === "string" && typeof second === "string") return `${first}\n${second}`;
  const firstParts = typeof first === "string" ? [{ type: "text" as const, text: first }] : [...first];
  const secondParts = typeof second === "string" ? [{ type: "text" as const, text: second }] : [...second];
  return [...firstParts, { type: "text" as const, text: "\n" }, ...secondParts];
}

function inlineFragmentCount(config: Config): number {
  return Math.max(1, Math.floor(config.session.compact.inlineFragments ?? DEFAULT_INLINE_FRAGMENTS));
}

/**
 * Projects the resident compact fragments into model-visible history. Each fragment covers only its
 * own raw window, so showing the newest `inlineFragments` of them is what preserves continuity; the
 * older ones live in the fragment store and are recalled on demand. Every summary is emitted as a
 * leading system entry before any non-system content.
 */
function createSummaryHistoryPlugin(inlineFragments: number, projection?: AgentRequestProjection, legacyRegions?: Conversation): AgentPlugin {
  return {
    name: "core.compact-history",
    enforce: "pre",
    transformEntries: async (entries) => {
      const regionalSummaries: AgentEntry[] = [];
      if (legacyRegions && entries.some((entry) => entry.type === "context-region")) {
        const rawIds = new Set(entries.filter((entry) => entry.type === "message").map((entry) => entry.id));
        const archived = (await legacyRegions.contextRegions()).filter((region) => !region.data.sourceEntryIds.every((id) => rawIds.has(id)));
        for (const region of archived.slice(-Math.max(1, inlineFragments))) {
          regionalSummaries.push(
            createEntry(
              "message",
              createSystemMessage(formatResidentCompactFragment(region.data.tiers.P1, { id: region.id, mode: "compartment" }), {
                id: region.id,
                timestamp: region.timestamp,
              }),
              { id: region.id, timestamp: region.timestamp },
            ),
          );
        }
      }
      const boundary = resolveLatestCompactBoundary(entries);
      if (!boundary) return [...regionalSummaries, ...entries];

      const resident = entries
        .filter((entry): entry is Extract<AgentEntry, { type: "compact" }> => entry.type === "compact")
        .slice(-Math.max(1, inlineFragments));
      const summaries = resident.map((compact) => {
        const entry = createEntry(
          "message",
          createSystemMessage(
            formatResidentCompactFragment(
              compact.data.summary,
              compact.data.mode === "compartment"
                ? {
                    id: compact.data.compartmentId ?? compact.id,
                    mode: "compartment",
                    ...(compact.data.compartmentLabel ? { label: compact.data.compartmentLabel } : {}),
                  }
                : {},
            ),
            {
              id: compact.id,
              timestamp: compact.timestamp,
            },
          ),
          { id: compact.id, timestamp: compact.timestamp },
        );
        projection?.register(entry.data, { kind: "summary", sourceEntryIds: [compact.id], timestamp: compact.timestamp });
        return entry;
      });
      const preservedBeforeCompact = entries.slice(boundary.tailStartIndex, boundary.compactIndex).filter((entry) => entry.type !== "compact");
      const afterCompact = entries.slice(boundary.compactIndex + 1);
      return [...regionalSummaries, ...summaries, ...preservedBeforeCompact, ...afterCompact];
    },
  };
}

function canonicalBotIdentity(bot: Bot): Bot {
  let current = bot;
  const seen = new Set<object>();

  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    let original: unknown;
    try {
      original = (current as unknown as Record<PropertyKey, unknown>)[CORDIS_ORIGINAL];
    } catch {
      break;
    }
    if (!original || (typeof original !== "object" && typeof original !== "function") || original === current) break;
    current = original as Bot;
  }

  return current;
}

function renderAssistantText(content: AssistantContent): string | undefined {
  if (typeof content === "string") return content.trim() ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content.map((part) => (typeof part === "string" ? part : part.type === "text" ? part.text : "")).join("");
  return text.trim() ? text : undefined;
}

/** Reads the request text the runtime already marked as the current turn input. */
function extractCurrentMessageQuery(messages: readonly ModelMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    const content = typeof message.content === "string" ? message.content : messageTextParts(message.content);
    const match = /\[CURRENT_MESSAGE\]\n?([\s\S]*?)\n?\[\/CURRENT_MESSAGE\]/.exec(content);
    const query = match?.[1]?.trim();
    if (query) return query;
  }
  return undefined;
}

function messageTextParts(content: readonly unknown[]): string {
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "type" in part && (part as { type?: string }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}
