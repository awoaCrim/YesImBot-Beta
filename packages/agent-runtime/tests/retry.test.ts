import type { LanguageModelV3, LanguageModelV3FinishReason, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAgent } from "../src/agent.js";
import { createUserMessage } from "../src/message.js";

function retryableError(statusCode = 429, isRetryable = true, retryImmediately = true): APICallError {
  return new APICallError({
    message: `fixture ${statusCode}`,
    url: "https://fixture.invalid/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseHeaders: retryImmediately ? { "retry-after": "0" } : undefined,
    isRetryable,
  });
}

function textStream(text = "ok"): ReadableStream<LanguageModelV3StreamPart> {
  const finishReason = "stop" as unknown as LanguageModelV3FinishReason;
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "text" });
      controller.enqueue({ type: "text-delta", id: "text", delta: text });
      controller.enqueue({ type: "text-end", id: "text" });
      controller.enqueue({
        type: "finish",
        finishReason,
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      });
      controller.close();
    },
  });
}

function toolCallStream(): ReadableStream<LanguageModelV3StreamPart> {
  const finishReason = "tool-calls" as unknown as LanguageModelV3FinishReason;
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "tool-input-start", id: "side-effect-1", toolName: "side_effect" });
      controller.enqueue({ type: "tool-input-delta", id: "side-effect-1", delta: "{}" });
      controller.enqueue({ type: "tool-input-end", id: "side-effect-1" });
      controller.enqueue({ type: "tool-call", toolCallId: "side-effect-1", toolName: "side_effect", input: "{}" });
      controller.enqueue({
        type: "finish",
        finishReason,
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 0, reasoning: 0 } },
      });
      controller.close();
    },
  });
}

function createFailThenSucceedModel(failures: number, error = retryableError()) {
  let attempts = 0;
  const model = {
    specificationVersion: "v3",
    provider: "fixture",
    modelId: "retry-model",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not implemented");
    },
    async doStream() {
      attempts += 1;
      if (attempts <= failures) throw error;
      return { stream: textStream() };
    },
  } as unknown as LanguageModelV3;
  return { model, attempts: () => attempts };
}

async function userMessageCount(agent: ReturnType<typeof createAgent>): Promise<number> {
  return (await agent.storage.read()).filter((entry) => entry.type === "message" && entry.data.role === "user").length;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("main model retries", () => {
  it("succeeds after retryable 429 responses without persisting the user message again", async () => {
    const fixture = createFailThenSucceedModel(2);
    const agent = createAgent({ model: fixture.model, maxRetries: 3 });
    const events = await Array.fromAsync(agent.run(createUserMessage("hello")));

    expect(fixture.attempts()).toBe(3);
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(await userMessageCount(agent)).toBe(1);
  });

  it("exhausts three retries after four total retryable-429 attempts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fixture = createFailThenSucceedModel(Number.POSITIVE_INFINITY);
    const agent = createAgent({ model: fixture.model, maxRetries: 3 });
    const events = await Array.fromAsync(agent.run(createUserMessage("hello")));

    expect(fixture.attempts()).toBe(4);
    expect(events.at(-1)?.type).toBe("turn.failed");
    expect(await userMessageCount(agent)).toBe(1);
    expect((await agent.storage.read()).filter((entry) => entry.type === "event" && entry.data.type === "turn.failed")).toHaveLength(1);
  });

  it("keeps the default at zero and bounds excessive retry configuration to five", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const defaultFixture = createFailThenSucceedModel(Number.POSITIVE_INFINITY);
    const defaultAgent = createAgent({ model: defaultFixture.model });
    const defaultEvents = await Array.fromAsync(defaultAgent.run(createUserMessage("default")));
    expect(defaultEvents.at(-1)?.type).toBe("turn.failed");
    expect(defaultFixture.attempts()).toBe(1);

    const boundedFixture = createFailThenSucceedModel(Number.POSITIVE_INFINITY);
    const boundedAgent = createAgent({ model: boundedFixture.model, maxRetries: 99 });
    const boundedEvents = await Array.fromAsync(boundedAgent.run(createUserMessage("bounded")));
    expect(boundedEvents.at(-1)?.type).toBe("turn.failed");
    expect(boundedFixture.attempts()).toBe(6);
  });

  it.each([
    [429, false],
    [503, true],
  ] as const)("does not retry status %s when the retry contract is not a retryable 429", async (statusCode, isRetryable) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fixture = createFailThenSucceedModel(Number.POSITIVE_INFINITY, retryableError(statusCode, isRetryable));
    const agent = createAgent({ model: fixture.model, maxRetries: 3 });
    const events = await Array.fromAsync(agent.run(createUserMessage("hello")));

    expect(fixture.attempts()).toBe(1);
    expect(events.at(-1)?.type).toBe("turn.failed");
  });

  it("aborts during retry backoff without issuing another provider call", async () => {
    let attempts = 0;
    let markAttempt!: () => void;
    const attempted = new Promise<void>((resolve) => {
      markAttempt = resolve;
    });
    const model = {
      specificationVersion: "v3",
      provider: "fixture",
      modelId: "retry-model",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented");
      },
      async doStream() {
        attempts += 1;
        markAttempt();
        throw retryableError(429, true, false);
      },
    } as unknown as LanguageModelV3;
    const agent = createAgent({ model, maxRetries: 3 });
    const events = Array.fromAsync(agent.run(createUserMessage("hello")));

    await attempted;
    await agent.interrupt("cancel retry");

    expect((await events).at(-1)?.type).toBe("turn.aborted");
    expect(attempts).toBe(1);
    expect(await userMessageCount(agent)).toBe(1);
  });

  it("retries only the failed model step and never replays a completed tool side effect", async () => {
    let modelCalls = 0;
    let sideEffects = 0;
    const model = {
      specificationVersion: "v3",
      provider: "fixture",
      modelId: "retry-model",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("not implemented");
      },
      async doStream() {
        modelCalls += 1;
        if (modelCalls === 1) return { stream: toolCallStream() };
        if (modelCalls === 2) throw retryableError();
        return { stream: textStream("done") };
      },
    } as unknown as LanguageModelV3;
    const agent = createAgent({
      model,
      maxRetries: 3,
      tools: [
        {
          name: "side_effect",
          inputSchema: z.object({}),
          execute: async () => {
            sideEffects += 1;
            return { ok: true };
          },
        },
      ],
    });

    const events = await Array.fromAsync(agent.run(createUserMessage("hello")));
    const messages = (await agent.storage.read()).filter((entry) => entry.type === "message").map((entry) => entry.data);

    expect(events.at(-1)?.type).toBe("turn.done");
    expect(modelCalls).toBe(3);
    expect(sideEffects).toBe(1);
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(messages.filter((message) => message.role === "tool")).toHaveLength(1);
  });
});
