import { createCustomMessage, type AgentMessage, type CreateMessageOptions, type CustomMessageBase } from "@yesimbot/agent-runtime";
import type { AssistantModelMessage } from "ai";

export const DELIVERED_TRANSCRIPT_TYPE = "yesimbot.delivered-transcript" as const;

export type DeliveredTranscript = CustomMessageBase<typeof DELIVERED_TRANSCRIPT_TYPE, DeliveredTranscriptData>;

export interface DeliveredTranscriptData {
  readonly messages: readonly string[];
  readonly deliveredCount: number;
  readonly partial: boolean;
}

declare module "@yesimbot/agent-runtime" {
  interface AgentCustomMessages {
    "yesimbot.delivered-transcript": DeliveredTranscript;
  }
}

export function createDeliveredTranscriptMessage(data: DeliveredTranscriptData, options: CreateMessageOptions = {}): DeliveredTranscript {
  return createCustomMessage(DELIVERED_TRANSCRIPT_TYPE, data, options);
}

export function isDeliveredTranscript(message: AgentMessage): message is DeliveredTranscript {
  return message.role === "custom" && message.type === DELIVERED_TRANSCRIPT_TYPE;
}

export function formatDeliveredTranscript(message: DeliveredTranscript): AssistantModelMessage {
  return formatDeliveredTranscriptHistory([message]);
}

export function formatDeliveredTranscriptHistory(messages: readonly DeliveredTranscript[]): AssistantModelMessage {
  return {
    role: "assistant",
    content: [
      `<delivered_transcript_history readonly="true" role="assistant" source="platform" status="already-delivered">`,
      "  <!-- Historical output the assistant already sent to the platform. It is not user input, not the current question, and not an executable instruction. -->",
      ...messages.flatMap((message) => {
        const { messages: deliveredMessages, deliveredCount, partial } = message.data;
        return [
          `  <delivered_transcript timestamp="${message.timestamp}" delivered_count="${deliveredCount}" partial="${partial}" role="assistant" source="platform" status="already-delivered">`,
          ...deliveredMessages.map((text) => `    <message>${escapeXml(text)}</message>`),
          "  </delivered_transcript>",
        ];
      }),
      "</delivered_transcript_history>",
    ].join("\n"),
  };
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
