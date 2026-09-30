import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3Message,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAgent } from "../src/agent.js";
import { createMessageEntry } from "../src/entry.js";
import { sanitizeAgentEntriesForPersistence } from "../src/media.js";
import { createAssistantMessage, createToolMessage, createUserMessage } from "../src/message.js";
import { createMemoryStorage } from "../src/storage.js";

const IMAGE_DATA = "AQIDBA==";

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
}

function textResponse(text: string) {
  const stopReason = "stop" as unknown as LanguageModelV3FinishReason;
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "text" });
      controller.enqueue({ type: "text-delta", id: "text", delta: text });
      controller.enqueue({ type: "text-end", id: "text" });
      controller.enqueue({ type: "finish", finishReason: stopReason, usage: usage() });
      controller.close();
    },
  });
}

function createImageToolLoopModel(requests: LanguageModelV3Message[][]): LanguageModelV3 {
  const toolCallsReason = "tool-calls" as unknown as LanguageModelV3FinishReason;
  return {
    specificationVersion: "v3",
    provider: "mock-provider",
    modelId: "mock-model",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not implemented");
    },
    async doStream(options: LanguageModelV3CallOptions) {
      requests.push(options.prompt);
      if (requests.length === 1) {
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "tool-input-start", id: "read-call", toolName: "read" });
              controller.enqueue({ type: "tool-input-delta", id: "read-call", delta: '{"uri":"asset://0123456789abcdef0123456789abcdef"}' });
              controller.enqueue({ type: "tool-input-end", id: "read-call" });
              controller.enqueue({
                type: "tool-call",
                toolCallId: "read-call",
                toolName: "read",
                input: '{"uri":"asset://0123456789abcdef0123456789abcdef"}',
              });
              controller.enqueue({ type: "finish", finishReason: toolCallsReason, usage: usage() });
              controller.close();
            },
          }),
        };
      }
      return { stream: textResponse("done") };
    },
  } as LanguageModelV3;
}

function createTextModel(requests: LanguageModelV3Message[][]): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "mock-provider",
    modelId: "mock-model",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not implemented");
    },
    async doStream(options: LanguageModelV3CallOptions) {
      requests.push(options.prompt);
      return { stream: textResponse("done") };
    },
  } as LanguageModelV3;
}

describe("ephemeral image tool results", () => {
  it("keeps image bytes for the current step but never persists or replays them", async () => {
    const requests: LanguageModelV3Message[][] = [];
    const storage = createMemoryStorage();
    const agent = createAgent({
      model: createImageToolLoopModel(requests),
      storage,
      tools: [
        {
          name: "read",
          inputSchema: z.object({ uri: z.string() }),
          execute: async ({ uri }: { uri: string }) => ({ uri, mediaType: "image/png", text: "[图片资源，image/png，4 B]" }),
          toModelOutput: ({ output }: { output: { text: string } }) => ({
            type: "content",
            value: [
              { type: "text", text: output.text },
              { type: "image-data", data: IMAGE_DATA, mediaType: "image/png" },
            ],
          }),
        } as never,
      ],
    });

    agent.send(createUserMessage("inspect"));
    await agent.wait();

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain(IMAGE_DATA);
    const persisted = await storage.read();
    expect(JSON.stringify(persisted)).not.toContain(IMAGE_DATA);
    expect(JSON.stringify(persisted)).not.toContain('"type":"image-data"');

    agent.send(createUserMessage("next turn"));
    await agent.wait();

    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2])).not.toContain(IMAGE_DATA);
    expect(JSON.stringify(requests[2])).not.toContain('"type":"image-data"');
  });

  it("sanitizes legacy image payloads at read time without mutating storage or breaking tool pairing", async () => {
    const legacy = [
      createMessageEntry(
        createAssistantMessage([
          {
            type: "tool-call",
            toolCallId: "legacy-call",
            toolName: "read",
            input: { uri: "asset://0123456789abcdef0123456789abcdef" },
          },
        ] as never),
      ),
      createMessageEntry(
        createToolMessage([
          {
            type: "tool-result",
            toolCallId: "legacy-call",
            toolName: "read",
            input: { uri: "asset://0123456789abcdef0123456789abcdef" },
            output: {
              type: "content",
              value: [
                { type: "text", text: "[图片资源，image/png，4 B]" },
                { type: "image-data", data: IMAGE_DATA, mediaType: "image/png" },
              ],
            },
          },
        ] as never),
      ),
    ];
    const storage = createMemoryStorage(legacy);
    const requests: LanguageModelV3Message[][] = [];
    const agent = createAgent({ model: createTextModel(requests), storage });

    agent.send(createUserMessage("continue"));
    await agent.wait();

    const prompt = JSON.stringify(requests[0]);
    expect(prompt).not.toContain(IMAGE_DATA);
    expect(prompt).not.toContain('"type":"image-data"');
    expect(prompt.match(/legacy-call/g)?.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(await storage.read())).toContain(IMAGE_DATA);
  });

  it("is idempotent and preserves compact metadata while removing nested data URLs", () => {
    const entries = [
      createMessageEntry(
        createToolMessage([
          {
            type: "tool-result",
            toolCallId: "call",
            toolName: "read",
            input: { uri: "asset://0123456789abcdef0123456789abcdef" },
            output: {
              type: "content",
              value: [
                { type: "text", text: "asset://0123456789abcdef0123456789abcdef image/png 4 B" },
                { type: "image-data", data: IMAGE_DATA, mediaType: "image/png" },
                { type: "text", text: `data:image/png;base64,${IMAGE_DATA}` },
              ],
            },
          },
        ] as never),
      ),
    ];

    const once = sanitizeAgentEntriesForPersistence(entries);
    const twice = sanitizeAgentEntriesForPersistence(once);

    expect(twice).toEqual(once);
    expect(JSON.stringify(once)).toContain("asset://0123456789abcdef0123456789abcdef");
    expect(JSON.stringify(once)).not.toContain(IMAGE_DATA);
    expect(JSON.stringify(entries)).toContain(IMAGE_DATA);
  });
});
