import { Schema, type Context, type Logger } from "koishi";
import type {
  ChannelContext,
  Event,
  Message,
  MessageBatchController,
  MessageBatchInput,
  MessageBatchPlugin,
  MessageBatchSetupExtensions,
} from "koishi-plugin-yesimbot";

export const Config: Schema<Config> = Schema.object({
  quietSeconds: Schema.number().min(0.1).max(3_600).step(0.1).default(15).description("同一会话最后一条普通消息或定向 poke 之后的安静等待秒数"),
});

type FlushMessages = (messages: readonly Message[]) => Promise<void>;

type FlushInputs = (inputs: readonly MessageBatchInput[]) => Promise<void>;

export interface Config {
  quietSeconds: number;
}

export class MessageDebounceController implements MessageBatchController {
  private readonly inputs: MessageBatchInput[] = [];
  private timerDisposer: (() => void) | undefined;
  private generation = 0;
  private stopped = false;

  public constructor(
    private readonly ctx: Context,
    private readonly quietMilliseconds: number,
    private readonly flushMessages: FlushMessages,
    private readonly flushInputs: FlushInputs | undefined,
    private readonly logger: Logger,
    private readonly onStop: () => void,
  ) {}

  public enqueue(input: Message): void {
    if (this.stopped) return;
    this.inputs.push(input);
    this.refreshTimer();
  }

  public enqueueEvent(input: Event): boolean {
    if (this.stopped || !this.flushInputs || !isTargetedPoke(input)) return false;
    this.inputs.push(input);
    this.refreshTimer();
    return true;
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    this.timerDisposer?.();
    this.timerDisposer = undefined;
    this.inputs.length = 0;
    this.onStop();
  }

  private refreshTimer(): void {
    this.timerDisposer?.();
    const generation = ++this.generation;
    this.timerDisposer = this.ctx.setTimeout(() => this.expire(generation), this.quietMilliseconds);
  }

  private expire(generation: number): void {
    if (this.stopped || generation !== this.generation) return;
    this.timerDisposer = undefined;
    const snapshot = this.inputs.splice(0);
    if (snapshot.length === 0) return;
    const task = this.flushInputs ? this.flushInputs(snapshot) : this.flushMessages(snapshot as readonly Message[]);
    void task.catch((cause) => {
      this.logger.warn("message_debounce.flush_failed", { cause: cause instanceof Error ? cause.message : String(cause) });
    });
  }
}

export default class MessageDebouncePlugin implements MessageBatchPlugin {
  public static readonly name = "yesimbot-message-debounce";
  public static readonly inject = ["yesimbot"];
  public static readonly usage = "为 YesImBot 普通消息和定向 poke 提供按会话 trailing-edge 防抖";
  public static readonly Config = Config;

  public readonly priority = 1_000;

  private readonly controllers = new Set<MessageDebounceController>();
  private readonly logger: Logger;
  private readonly quietMilliseconds: number;
  private disposeRegistration: (() => void) | undefined;
  private stopped = false;

  public constructor(
    private readonly ctx: Context,
    config: Config,
  ) {
    config = Config(config ?? {}) as Config;
    this.quietMilliseconds = config.quietSeconds * 1_000;
    this.logger = ctx.logger("yesimbot.message-debounce");
    this.disposeRegistration = ctx.yesimbot.message.use(this);
    ctx.on("dispose", () => this.stop());
  }

  public match(_context: ChannelContext): boolean {
    return true;
  }

  public setup(context: ChannelContext, flushMessages: FlushMessages, extensions?: MessageBatchSetupExtensions): MessageBatchController {
    if (this.stopped) throw new Error("Message debounce plugin is stopped");
    let controller!: MessageDebounceController;
    controller = new MessageDebounceController(this.ctx, this.quietMilliseconds, flushMessages, extensions?.flushInputs, this.logger, () =>
      this.controllers.delete(controller),
    );
    this.controllers.add(controller);
    this.logger.debug("message_debounce.controller_created", {
      type: context.type,
      platform: context.platform,
      channelId: context.channelId,
      quietMilliseconds: this.quietMilliseconds,
      eventBatching: extensions !== undefined,
    });
    return controller;
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.disposeRegistration?.();
    this.disposeRegistration = undefined;
    for (const controller of [...this.controllers]) controller.stop();
    this.controllers.clear();
  }
}

function isTargetedPoke(input: Event): boolean {
  const data = input.data as unknown as { readonly eventType?: string; readonly actorId?: unknown; readonly targetId?: unknown };
  return data.eventType === "notice.poke" && typeof data.actorId === "string" && data.actorId.length > 0 && data.targetId === input.data.selfId;
}
