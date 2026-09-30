import type { TurnResult } from "@yesimbot/agent-runtime";
import type { Awaitable, Session, Universal } from "koishi";

import type { ChannelContext } from "../channels/index.js";
import type { MessageBatchInput } from "../message-batches/index.js";
import { isMessage, type Event, type Message } from "../messages/index.js";

export const defaultWillEngine: WillEngine = {
  decide(input: Message | Event, _state: WillState): "wait" | "trigger" {
    if (!isMessage(input)) return "wait";
    if (input.data.channel.type === (1 satisfies Universal.Channel.Type)) return "trigger";
    return input.data.elements.some((element) => element.type === "at" && String(element.attrs.id) === input.data.selfId) ? "trigger" : "wait";
  },
  debug(): WillDebug {
    return {
      engine: "default",
      config: { direct: "trigger", mention: "trigger", group: "wait" },
    };
  },
};

export interface WillState {
  readonly activeTurnId: string | null;
}

export interface WillBatchDecision {
  readonly decision: "wait" | "trigger";
  readonly candidate?: {
    readonly inputId: string;
    readonly authorId: string;
    readonly score: number;
    readonly probability: number;
  };
  readonly reservationId?: string;
}

export type WillReservationOutcome =
  | { readonly kind: "commit"; readonly turnId: string; readonly messageId: string }
  | {
      readonly kind: "release";
      readonly turnId?: string;
      readonly reason: "done-without-delivery" | "failed" | "aborted" | "consume-failed" | "start-failed";
    };

export interface WillEngine {
  decide(input: Message | Event, state: WillState): Awaitable<"wait" | "trigger">;
  decideBatch?(inputs: readonly MessageBatchInput[], state: WillState): Awaitable<WillBatchDecision>;
  settleReservation?(reservationId: string, outcome: WillReservationOutcome): Awaitable<void>;
  observe?(result: TurnResult): Awaitable<void>;
  debug?(): WillDebug | undefined;
}

export interface WillDebug {
  readonly engine: "default" | "routing" | "willingness";
  readonly config?: Record<string, unknown>;
  readonly score?: number;
  readonly probability?: number;
}

export interface WillPlugin {
  readonly priority: number;
  match(session: Session): boolean;
  matchContext?(context: ChannelContext): boolean;
  setup(context: ChannelContext): Awaitable<WillEngine>;
}
