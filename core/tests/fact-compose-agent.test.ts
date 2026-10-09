import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createAgent, createAssistantMessage, createEntry, createMemoryStorage, createToolMessage, createUserMessage } from "@yesimbot/agent-runtime";
import { describe, expect, it, vi } from "vitest";
vi.mock("koishi", async () => import("@koishijs/core"));
import { createFinishTool, createSendMessageTool } from "../src/agents/tools.js";
import { AssistantHistoryFacts } from "../src/conversations/assistant-facts.js";
import { createInternalHistoryProjectionPlugin } from "../src/conversations/internal-history.js";

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
function model(script: readonly { name: string; input: string }[] = []) {
  const calls: LanguageModelV3CallOptions[] = [];
  const value: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "main",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("Unexpected generation");
    },
    doStream: async (options) => {
      const action = script[calls.length];
      calls.push(structuredClone(options));
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (action)
              controller.enqueue({
                type: "tool-call",
                toolCallId: `call_${calls.length}`,
                toolName: action.name,
                input: action.input,
                providerMetadata: { google: { thoughtSignature: action.name === "send_message" ? "LIVE_SIGNED_CALL" : "FINISH_SIGNATURE" } },
              });
            controller.enqueue({ type: "finish", finishReason: { unified: action ? "tool-calls" : "stop", raw: undefined }, usage });
            controller.close();
          },
        }),
      };
    },
  };
  return { value, calls };
}

function auxiliary() {
  const calls: LanguageModelV3CallOptions[] = [];
  const value: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "aux",
    supportedUrls: {},
    doStream: async () => {
      throw new Error("Unexpected stream");
    },
    doGenerate: async (options) => {
      calls.push(structuredClone(options));
      const text = options.prompt
        .filter((message) => message.role === "user")
        .flatMap((message) => message.content.filter((part) => part.type === "text").map((part) => part.text))
        .join("\n");
      const payload = text
        .split("\n")[1]!
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
      const source = JSON.parse(payload) as Array<{ id: string }>;
      return {
        content: [{ type: "text", text: JSON.stringify({ records: source.map(({ id }) => ({ id, facts: ["助手确认了订单信息，未证明后续执行。"] })) }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      };
    },
  };
  return { value, calls };
}

function oldEntries() {
  return [
    createEntry("message", createUserMessage("原始用户消息？！", { id: "old_u", timestamp: 1 }), { id: "old_u", timestamp: 1 }),
    createEntry(
      "message",
      createAssistantMessage(
        [
          {
            type: "tool-call",
            toolCallId: "old_send",
            toolName: "send_message",
            input: { messages: ["旧台词呀！！"] },
            providerOptions: { google: { thoughtSignature: "OLD_SIGNATURE" } },
          },
        ],
        { id: "old_a", timestamp: 2 },
      ),
      { id: "old_a", timestamp: 2 },
    ),
    createEntry(
      "message",
      createToolMessage(
        [
          {
            type: "tool-result",
            toolCallId: "old_send",
            toolName: "send_message",
            output: { type: "json", value: { ok: true, count: 1, messageIds: ["old_platform_id"] } },
          },
        ],
        { id: "old_r", timestamp: 3 },
      ),
      { id: "old_r", timestamp: 3 },
    ),
  ];
}

describe("real Agent / AI SDK synthetic boundary", () => {
  it("neutralizes recent history but retains live signed calls and actual receipts on every continuation", async () => {
    const aux = auxiliary();
    const entries = oldEntries();
    const before = JSON.stringify(entries);
    const facts = new AssistantHistoryFacts({ scope: () => "channel:g1", resolveModel: () => ({ key: "aux:r1", model: aux.value }) });
    const input = { facts: ["订单已经确认"], intent: "告知完成", inner_thought: "CURRENT_PRIVATE_JUDGMENT", mode: "raw", continue: true };
    const main = model([
      { name: "send_message", input: JSON.stringify(input) },
      { name: "finish", input: "{}" },
      { name: "finish", input: "{}" },
    ]);
    const sendMessage = vi.fn(async () => ["platform_id"]);
    const composer = vi.fn(async () => ["已经核对啦。", "订单没问题。"]);
    const storage = createMemoryStorage(entries);
    const agent = createAgent({
      model: main.value,
      storage,
      plugins: [facts.plugin()],
      tools: [
        createSendMessageTool({
          bot: { platform: "test", sendMessage } as never,
          channelId: "room",
          resources: {} as never,
          pacing: { charactersPerSecond: 1000, maxTotalDelayMs: 0 },
          innerThought: true,
          polisherMode: "compose",
          polish: composer,
        }),
        createFinishTool(),
      ],
    });
    try {
      for await (const _event of agent.run(createUserMessage("当前用户原话！？"))) {
        /* exercise actual SDK */
      }
      expect(main.calls).toHaveLength(2);
      expect(aux.calls).toHaveLength(1);
      const initial = JSON.stringify(main.calls[0]!.prompt);
      const continuation = JSON.stringify(main.calls[1]!.prompt);
      expect(initial).toContain("原始用户消息？！");
      expect(initial).toContain("当前用户原话！？");
      expect(initial).toContain("助手确认了订单信息");
      expect(initial).not.toMatch(/旧台词|OLD_SIGNATURE|old_send/);
      expect(continuation).toContain("LIVE_SIGNED_CALL");
      expect(continuation).toContain("CURRENT_PRIVATE_JUDGMENT");
      expect(continuation).toContain("已经核对啦");
      expect(continuation).toContain("deliveredMessages");
      expect(composer).toHaveBeenCalledOnce();
      expect(composer).toHaveBeenCalledWith(expect.objectContaining({ mode: "compose", messages: [], facts: input.facts, intent: input.intent }));
      expect(JSON.stringify(composer.mock.calls)).not.toContain("CURRENT_PRIVATE_JUDGMENT");
      expect(sendMessage).toHaveBeenCalledTimes(2);
      for await (const _event of agent.run(createUserMessage("下一回合"))) {
        /* previous live chain is now historical */
      }
      expect(aux.calls).toHaveLength(2);
      const next = JSON.stringify(main.calls[2]!.prompt);
      expect(next).not.toMatch(/旧台词|已经核对啦|CURRENT_PRIVATE_JUDGMENT|LIVE_SIGNED_CALL|OLD_SIGNATURE/);
      expect(next).toContain("下一回合");
      expect(next).toContain("助手确认了订单信息");
      expect(JSON.stringify(aux.calls)).not.toContain("CURRENT_PRIVATE_JUDGMENT");
      expect(JSON.stringify(entries)).toBe(before);
      const persisted = JSON.stringify(await storage.read());
      expect(persisted).toContain("LIVE_SIGNED_CALL");
      expect(persisted).toContain("已经核对啦");
    } finally {
      await agent.stop();
    }
  });
  it("preserves the disabled provider-native history contract", async () => {
    const main = model();
    const agent = createAgent({
      model: main.value,
      storage: createMemoryStorage(oldEntries()),
      plugins: [createInternalHistoryProjectionPlugin("gemini-native")],
    });
    try {
      for await (const _event of agent.run(createUserMessage("新问题"))) {
        /* real SDK, no network */
      }
      const text = JSON.stringify(main.calls[0]!.prompt);
      expect(text).toContain("旧台词呀");
      expect(text).toContain("OLD_SIGNATURE");
      expect(text).toContain("old_send");
    } finally {
      await agent.stop();
    }
  });
});
