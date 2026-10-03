import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3Message,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAgent, createEntry, createMemoryStorage } from "../src/index.js";
import type { AgentEntry, AgentInternalEvent, AgentMessage, AgentPlugin } from "../src/index.js";
import { createUserMessage } from "../src/message.js";

const SEND_TOOL_CALL_ID = "call_send_1";
const SECOND_SEND_TOOL_CALL_ID = "call_send_2";

function flattenPromptContent(message: LanguageModelV3Message) {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "tool-call") return { type: part.type, toolName: part.toolName, toolCallId: part.toolCallId };
    if (part.type === "tool-result") return { type: part.type, toolName: part.toolName, toolCallId: part.toolCallId };
    return { type: part.type };
  });
}

/** Provider steps send messages and stay in the loop until the final text-only step. */
function createSendMessageContinuationModel(
  modelRequests: LanguageModelV3Message[][],
  continuationToolCallIds: readonly string[] = [SEND_TOOL_CALL_ID],
): LanguageModelV3 {
  const stopReason = "stop" as unknown as LanguageModelV3FinishReason;
  const toolCallsReason = "tool-calls" as unknown as LanguageModelV3FinishReason;
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 0, reasoning: 0 } };

  return {
    specificationVersion: "v3",
    provider: "mock-provider",
    modelId: "mock-model",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not implemented");
    },
    async doStream(options: LanguageModelV3CallOptions) {
      modelRequests.push(options.prompt);

      const toolCallId = continuationToolCallIds[modelRequests.length - 1];
      if (toolCallId) {
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "tool-input-start", id: toolCallId, toolName: "send_message" });
              controller.enqueue({ type: "tool-input-delta", id: toolCallId, delta: '{"messages":["先发一句"],"continue":true}' });
              controller.enqueue({ type: "tool-input-end", id: toolCallId });
              controller.enqueue({
                type: "tool-call",
                toolCallId,
                toolName: "send_message",
                input: '{"messages":["先发一句"],"continue":true}',
              });
              controller.enqueue({ type: "finish", finishReason: toolCallsReason, usage });
              controller.close();
            },
          }),
        };
      }

      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text_2" });
            controller.enqueue({ type: "text-delta", id: "text_2", delta: "done" });
            controller.enqueue({ type: "text-end", id: "text_2" });
            controller.enqueue({ type: "finish", finishReason: stopReason, usage });
            controller.close();
          },
        }),
      };
    },
  } as unknown as LanguageModelV3;
}

function createSendMessageTool() {
  return {
    name: "send_message",
    inputSchema: z.object({ messages: z.array(z.string()), continue: z.boolean().optional() }),
    execute: async () => ({ ok: true, count: 1 }),
  } as never;
}

/** Reproduces the production failure shape if a current-turn result reaches historical projection. */
function createDeliveredOutputProjection(): AgentPlugin {
  return {
    name: "test-history-projection",
    transformEntries(entries) {
      return entries.filter(
        (entry) =>
          entry.type !== "message" ||
          entry.data.role !== "tool" ||
          !entry.data.content.some((part) => part.type === "tool-result" && part.toolName === "send_message"),
      );
    },
  };
}

describe("transformEntries hook", () => {
  it("plugin can filter entries before model context is built", async () => {
    const transformFn = vi.fn((entries: readonly AgentEntry[]) => entries.filter((entry) => entry.type === "message"));

    const plugin: AgentPlugin = { name: "test-transform", transformEntries: transformFn };

    const storage = createMemoryStorage([
      createEntry("message", { role: "user", id: "m1", timestamp: 1, content: "hello" } as AgentMessage),
      createEntry("state", { version: 1 } as AgentEntry<"state">["data"]),
      createEntry("message", { role: "assistant", id: "m2", timestamp: 2, content: "hi" } as AgentMessage),
    ]);

    const mockModel = {
      doGenerate: vi.fn().mockResolvedValue({ text: "response", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } }),
      provider: "mock",
      modelId: "mock-model",
      specificationVersion: "v1",
    } as unknown as LanguageModel;

    const agent = createAgent({ model: mockModel, storage, plugins: [plugin], systemPrompt: "test" });

    await agent.init();
    expect(transformFn).not.toHaveBeenCalled();
  });

  it("transformEntries is called when collecting history entries", async () => {
    const callCount: number[] = [];
    const returnedCounts: number[] = [];
    const filterPlugin: AgentPlugin = {
      name: "filter-plugin",
      transformEntries(entries) {
        callCount.push(entries.length);
        const filtered = entries.filter((e) => e.type === "message");
        returnedCounts.push(filtered.length);
        return filtered;
      },
    };

    const storage = createMemoryStorage([
      createEntry("message", { role: "user", id: "m1", timestamp: 1, content: [] } as AgentMessage),
      createEntry("state", { version: 1 } as AgentEntry<"state">["data"]),
      createEntry("message", { role: "assistant", id: "m2", timestamp: 2, content: [] } as AgentMessage),
    ]);

    let _doGenerateCalled = false;
    const mockModel = {
      specificationVersion: "v1" as const,
      provider: "mock",
      modelId: "mock-model",
      doGenerate: vi.fn().mockImplementation(async () => {
        _doGenerateCalled = true;
        return {
          content: [{ type: "text", text: "response" }],
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5 },
          rawCall: { rawPrompt: [], rawSettings: {} },
        };
      }),
    } as unknown as LanguageModel;

    const agent = createAgent({ model: mockModel, storage, plugins: [filterPlugin], systemPrompt: "test" });
    agent.send(createUserMessage("hello"));

    await agent.wait();

    expect(callCount.length).toBeGreaterThan(0);
    for (const count of callCount) {
      expect(count).toBeGreaterThan(0);
    }
    for (const returned of returnedCounts) {
      expect(returned).toBeLessThanOrEqual(callCount[0]);
    }
  });

  it("keeps current-turn tool-call/tool-result pairs stable and deduplicated across continuations", async () => {
    const modelRequests: LanguageModelV3Message[][] = [];
    const agent = createAgent({
      model: createSendMessageContinuationModel(modelRequests, [SEND_TOOL_CALL_ID, SECOND_SEND_TOOL_CALL_ID]),
      tools: [createSendMessageTool()],
      plugins: [createDeliveredOutputProjection()],
    });

    const events: AgentInternalEvent[] = [];
    for await (const event of agent.run(createUserMessage("先说一句再继续"))) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "turn.failed")).toEqual([]);
    expect(modelRequests).toHaveLength(3);
    expect(modelRequests[1].map(flattenPromptContent)).toEqual([
      ["先说一句再继续"],
      [{ type: "tool-call", toolName: "send_message", toolCallId: SEND_TOOL_CALL_ID }],
      [{ type: "tool-result", toolName: "send_message", toolCallId: SEND_TOOL_CALL_ID }],
    ]);
    expect(modelRequests[2].map(flattenPromptContent)).toEqual([
      ["先说一句再继续"],
      [{ type: "tool-call", toolName: "send_message", toolCallId: SEND_TOOL_CALL_ID }],
      [{ type: "tool-result", toolName: "send_message", toolCallId: SEND_TOOL_CALL_ID }],
      [{ type: "tool-call", toolName: "send_message", toolCallId: SECOND_SEND_TOOL_CALL_ID }],
      [{ type: "tool-result", toolName: "send_message", toolCallId: SECOND_SEND_TOOL_CALL_ID }],
    ]);
  });

  it("keeps continuation context while event history mode excludes persisted conversation history", async () => {
    const modelRequests: LanguageModelV3Message[][] = [];
    const transformEntries = vi.fn((entries: readonly AgentEntry[]) => [...entries]);
    const agent = createAgent({
      model: createSendMessageContinuationModel(modelRequests),
      tools: [createSendMessageTool()],
      plugins: [{ name: "record-event-transform", transformEntries }],
      storage: createMemoryStorage([createEntry("message", createUserMessage("OLD_HISTORY_SENTINEL"), { id: "old-user", timestamp: 1 })]),
    });

    await Array.fromAsync(agent.run(createUserMessage("当前事件"), { historyMode: "event" }));

    expect(transformEntries).not.toHaveBeenCalled();
    expect(modelRequests).toHaveLength(2);
    expect(modelRequests[1].map(flattenPromptContent)).toEqual([
      ["当前事件"],
      [{ type: "tool-call", toolName: "send_message", toolCallId: SEND_TOOL_CALL_ID }],
      [{ type: "tool-result", toolName: "send_message", toolCallId: SEND_TOOL_CALL_ID }],
    ]);
    expect(JSON.stringify(modelRequests)).not.toContain("OLD_HISTORY_SENTINEL");
  });

  it("does not collect deferred ordinary appends into an active event continuation", async () => {
    const modelRequests: LanguageModelV3Message[][] = [];
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = createAgent({
      model: createSendMessageContinuationModel(modelRequests),
      tools: [
        {
          name: "send_message",
          inputSchema: z.object({ messages: z.array(z.string()), continue: z.boolean().optional() }),
          execute: async () => {
            entered();
            await gate;
            return { ok: true, count: 1 };
          },
        },
      ],
    });
    const event = Array.fromAsync(agent.run(createUserMessage("isolated event"), { historyMode: "event" }));
    await ready;
    const ordinary = createUserMessage("DEFERRED ordinary input");
    await agent.append(ordinary);
    agent.send(ordinary, { ifBusy: "defer" });
    release();
    await event;
    await agent.wait();
    expect(JSON.stringify(modelRequests[1])).toContain("isolated event");
    expect(JSON.stringify(modelRequests[1])).not.toContain("DEFERRED ordinary input");
    expect(JSON.stringify(modelRequests[2])).toContain("DEFERRED ordinary input");
  });

  it("keeps projected compact summaries before raw current-turn continuation entries", async () => {
    const modelRequests: LanguageModelV3Message[][] = [];
    const storage = createMemoryStorage<AgentEntry>([createEntry("message", createUserMessage("old request"), { id: "old-user", timestamp: 1 })]);
    const compactProjection: AgentPlugin = {
      name: "test-compact-projection",
      transformEntries(entries) {
        const compact = entries.find((entry) => entry.type === "compact");
        if (!compact) return [...entries];
        return [
          createEntry("message", { role: "system", id: "summary-message", timestamp: compact.timestamp, content: "projected summary" } as AgentMessage, {
            id: compact.id,
            timestamp: compact.timestamp,
          }),
        ];
      },
    };
    let appendedCompact = false;
    const agent = createAgent({
      model: createSendMessageContinuationModel(modelRequests),
      tools: [createSendMessageTool()],
      plugins: [compactProjection],
      storage,
      async beforeModelRequest({ stepNumber }) {
        if (stepNumber !== 0 || appendedCompact) return;
        appendedCompact = true;
        await storage.append(createEntry("compact", { summary: "projected summary", lastEntryId: "old-user" }, { id: "compact-1", timestamp: 3 }));
      },
    });

    await Array.fromAsync(agent.run(createUserMessage("current request")));

    expect(modelRequests).toHaveLength(2);
    expect(modelRequests[1].map(flattenPromptContent)).toEqual([
      "projected summary",
      ["current request"],
      [{ type: "tool-call", toolName: "send_message", toolCallId: SEND_TOOL_CALL_ID }],
      [{ type: "tool-result", toolName: "send_message", toolCallId: SEND_TOOL_CALL_ID }],
    ]);
  });

  it("never exposes current-turn live entries to the persisted-history projection", async () => {
    const modelRequests: LanguageModelV3Message[][] = [];
    const transformedIdSets: string[][] = [];
    const recordPlugin: AgentPlugin = {
      name: "record-transform",
      transformEntries(entries) {
        transformedIdSets.push(entries.map((entry) => entry.id));
        return [...entries];
      },
    };
    const agent = createAgent({
      model: createSendMessageContinuationModel(modelRequests),
      tools: [createSendMessageTool()],
      plugins: [recordPlugin],
      storage: createMemoryStorage([
        createEntry("message", createUserMessage("earlier question"), { id: "old-user", timestamp: 1 }),
        createEntry("message", { role: "assistant", id: "old-assistant-message", content: "earlier answer" } as AgentMessage, {
          id: "old-assistant",
          timestamp: 2,
        }),
      ]),
    });

    await Array.fromAsync(agent.run(createUserMessage("先说一句再继续")));

    expect(modelRequests).toHaveLength(2);
    expect(transformedIdSets.length).toBeGreaterThan(0);
    expect(transformedIdSets).toEqual(transformedIdSets.map(() => ["old-user", "old-assistant"]));
  });
});
