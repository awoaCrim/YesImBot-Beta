import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3FinishReason, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createAgent, createAssistantMessage, createEntry, createMemoryStorage, createToolMessage, createUserMessage } from "@yesimbot/agent-runtime";
import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { Universal } from "koishi";

import { INTERNAL_HISTORY_PROJECTION_PLUGIN } from "../src/conversations/internal-history.js";
import { createEvent, formatInput, isEvent, type EventRecord } from "../src/messages/index.js";

function deliveryEvent(text: string, timestamp: number): ReturnType<typeof createEvent> {
  const record: EventRecord<"delivery.failed"> = {
    platform: "onebot",
    selfId: "3535802886",
    channel: { id: "private:1049700117", type: Universal.Channel.Type.DIRECT },
    timestamp,
    eventType: "delivery.failed",
    delivery: {
      turnId: "turn-1",
      messageId: "message-1",
      segmentIndex: 1,
      segmentTotal: 1,
      error: { name: "Error", message: "offline" },
    },
    text,
  };
  return createEvent(record);
}

function createCaptureModel(prompts: LanguageModelV3CallOptions["prompt"][]) {
  const stopReason = "stop" as unknown as LanguageModelV3FinishReason;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "capture",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not implemented");
    },
    async doStream(options: LanguageModelV3CallOptions) {
      prompts.push(options.prompt);
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text-1" });
            controller.enqueue({ type: "text-delta", id: "text-1", delta: "ok" });
            controller.enqueue({ type: "text-end", id: "text-1" });
            controller.enqueue({
              type: "finish",
              finishReason: stopReason,
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
            });
            controller.close();
          },
        }),
      };
    },
  } as unknown as LanguageModelV3;
}

function inputPlugin() {
  return {
    name: "test-core-model-input",
    enforce: "pre" as const,
    toModelMessages(message: Parameters<typeof formatInput>[0]) {
      if (isEvent(message)) return [formatInput(message)];
      return [];
    },
  };
}

describe("notify event model history", () => {
  it("isolates an event-triggered turn from the previous unfinished request", async () => {
    const prompts: LanguageModelV3CallOptions["prompt"][] = [];
    const oldUser = createEntry("message", { id: "old-user", timestamp: 1, role: "user", content: "阿侬来张自拍" });
    const oldAssistant = createEntry(
      "message",
      createAssistantMessage(
        [
          {
            type: "tool-call",
            toolCallId: "old-send",
            toolName: "send_message",
            input: { messages: ["旧自拍回复", "artifact://old-selfie"] },
          },
        ],
        { id: "old-assistant", timestamp: 2 },
      ),
    );
    const oldTool = createEntry(
      "message",
      createToolMessage([{ type: "tool-result", toolCallId: "old-send", toolName: "send_message", output: { type: "json", value: { ok: true } } }], {
        id: "old-tool",
        timestamp: 2,
      }),
    );
    const currentEvent = deliveryEvent("商城任务已完成：只报告当前事件，不要重复旧请求。", 3);
    const agent = createAgent({
      model: createCaptureModel(prompts),
      storage: createMemoryStorage([oldUser, oldAssistant, oldTool]),
      plugins: [INTERNAL_HISTORY_PROJECTION_PLUGIN, inputPlugin()],
    });

    const stream = agent.run(currentEvent, { historyMode: "event" });
    for await (const _event of stream) {
      // consume the real turn
    }
    const prompt = JSON.stringify(prompts[0]);
    expect(prompt).toContain("商城任务已完成");
    expect(prompt).not.toContain("阿侬来张自拍");
    expect(prompt).not.toContain("old-selfie");
    await agent.stop();
  });

  it("does not replay a completed image action trace in an ordinary turn", async () => {
    const prompts: LanguageModelV3CallOptions["prompt"][] = [];
    const oldUser = createEntry("message", createUserMessage("画个阿侬版本的"), { id: "old-image-user", timestamp: 1 });
    const oldAssistant = createEntry(
      "message",
      createAssistantMessage(
        [
          {
            type: "tool-call",
            toolCallId: "old-read",
            toolName: "read",
            input: { uri: "artifact://old-reference" },
          },
          {
            type: "tool-call",
            toolCallId: "old-edit",
            toolName: "edit_image",
            input: { prompt: "让她恶狠狠盯着镜头" },
          },
          {
            type: "tool-call",
            toolCallId: "old-generate",
            toolName: "generate_image",
            input: { prompt: "阿侬版本，恶狠狠盯镜头" },
          },
          {
            type: "tool-call",
            toolCallId: "old-send",
            toolName: "send_message",
            input: { messages: ['<img src="artifact://old-image"/>'] },
          },
        ],
        { id: "old-image-assistant", timestamp: 2 },
      ),
    );
    const oldTool = createEntry(
      "message",
      createToolMessage(
        [
          { type: "tool-result", toolCallId: "old-read", toolName: "read", output: { type: "json", value: { ok: true } } },
          { type: "tool-result", toolCallId: "old-edit", toolName: "edit_image", output: { type: "json", value: { uri: "artifact://old-image" } } },
          { type: "tool-result", toolCallId: "old-generate", toolName: "generate_image", output: { type: "json", value: { uri: "artifact://old-image" } } },
          { type: "tool-result", toolCallId: "old-send", toolName: "send_message", output: { type: "json", value: { ok: true } } },
        ],
        { id: "old-image-tool", timestamp: 2 },
      ),
    );
    const agent = createAgent({
      model: createCaptureModel(prompts),
      storage: createMemoryStorage([oldUser, oldAssistant, oldTool]),
      plugins: [INTERNAL_HISTORY_PROJECTION_PLUGIN],
    });
    const stream = agent.run(createUserMessage("90块能用多少glm5.3flash"));
    for await (const _event of stream) {
      // consume the real turn
    }
    const prompt = JSON.stringify(prompts[0]);
    expect(prompt).toContain("90块能用多少glm5.3flash");
    expect(prompt).not.toContain("artifact://old-image");
    expect(prompt).not.toContain("artifact://old-reference");
    expect(prompt).not.toContain("generate_image");
    expect(prompt).not.toContain("edit_image");
    await agent.stop();
  });

  it("does not feed a persisted runtime event back into a later ordinary turn", async () => {
    const prompts: LanguageModelV3CallOptions["prompt"][] = [];
    const oldEvent = createEntry("message", deliveryEvent("OLD_EVENT_SENTINEL", 1));
    const currentMessage = { id: "current-user", timestamp: 2, role: "user" as const, content: "普通问题" };
    const agent = createAgent({
      model: createCaptureModel(prompts),
      storage: createMemoryStorage([oldEvent]),
      plugins: [INTERNAL_HISTORY_PROJECTION_PLUGIN, inputPlugin()],
    });

    const stream = agent.run(currentMessage);
    for await (const _event of stream) {
      // consume the real turn
    }
    expect(JSON.stringify(prompts[0])).not.toContain("OLD_EVENT_SENTINEL");
    await agent.stop();
  });
});
