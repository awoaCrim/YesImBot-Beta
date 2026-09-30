import type { Awaitable } from "koishi";

import type { ChannelContext } from "../channels/index.js";
import type { Event, Message } from "../messages/index.js";

type Disposer = () => void;

type RevisionListener = (revision: number) => void;

export type MessageBatchInput = Message | Event;

export interface MessageBatchSetupExtensions {
  flushInputs(inputs: readonly MessageBatchInput[]): Promise<void>;
}

export interface MessageBatchController {
  enqueue(input: Message): void;
  enqueueEvent?(input: Event): boolean;
  stop?(): Awaitable<void>;
}

export interface MessageBatchPlugin {
  readonly priority: number;
  match(context: ChannelContext): boolean;
  setup(
    context: ChannelContext,
    flushMessages: (messages: readonly Message[]) => Promise<void>,
    extensions?: MessageBatchSetupExtensions,
  ): Awaitable<MessageBatchController>;
}

export class MessageBatchRegistry {
  private readonly plugins = new Set<MessageBatchPlugin>();
  private readonly revisionListeners = new Set<RevisionListener>();
  private revisionValue = 0;

  public get revision(): number {
    return this.revisionValue;
  }

  public use(plugin: MessageBatchPlugin): Disposer {
    if (!this.plugins.has(plugin)) {
      this.plugins.add(plugin);
      this.bumpRevision();
    }
    return () => {
      if (this.plugins.delete(plugin)) this.bumpRevision();
    };
  }

  public select(context: ChannelContext): MessageBatchPlugin | undefined {
    const plugins = [...this.plugins].map((plugin, index) => ({ plugin, index }));
    plugins.sort((left, right) => left.plugin.priority - right.plugin.priority || left.index - right.index);
    return plugins.find(({ plugin }) => plugin.match(context))?.plugin;
  }

  public onRevision(listener: RevisionListener): Disposer {
    this.revisionListeners.add(listener);
    return () => {
      this.revisionListeners.delete(listener);
    };
  }

  private bumpRevision(): void {
    this.revisionValue += 1;
    for (const listener of this.revisionListeners) {
      try {
        listener(this.revisionValue);
      } catch {}
    }
  }
}
