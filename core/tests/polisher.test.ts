import type { AgentMessage } from "@yesimbot/agent-runtime";
import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import {
  buildPolisherTurnContext,
  createSendMessagePolisher,
  extractProtectedTokens,
  PolisherRegistry,
  validatePolishedMessages,
  type MessagePolisherCapability,
} from "../src/agents/polisher.js";
import { createSendMessageTool, type SendMessageToolOptions } from "../src/agents/tools.js";
import type { ChannelContext } from "../src/channels/index.js";

const context: ChannelContext = { type: "guild", platform: "test", channelId: "room", guildId: "room" };

function execution(messages: readonly AgentMessage[] = []) {
  return { toolCallId: "call", turnId: "turn", abortSignal: undefined, messages } as never;
}

function createTool(extra: { sendMessage?: ReturnType<typeof vi.fn>; polish?: SendMessageToolOptions["polish"] } = {}) {
  const sendMessage = extra.sendMessage ?? vi.fn(async () => ["m1"]);
  const tool = createSendMessageTool({
    bot: { platform: "test", sendMessage } as never,
    channelId: "room",
    resources: {} as never,
    pacing: { charactersPerSecond: 1000, maxTotalDelayMs: 60_000 },
    innerThought: false,
    ...(extra.polish ? { factsRequired: true, polish: extra.polish } : {}),
  });
  return { tool, sendMessage };
}

function sentPayload(sendMessage: ReturnType<typeof vi.fn>, index = 0): string {
  return JSON.stringify(sendMessage.mock.calls[index]?.[1]);
}

function createPolishHook(polish: MessagePolisherCapability["polish"]) {
  const registry = new PolisherRegistry();
  registry.use({ name: "test", polish });
  return createSendMessagePolisher({ registry, resolveProfile: async () => ({ persona: "p" }), context });
}

function currentTurnMessages(): AgentMessage[] {
  return [
    {
      id: "user",
      timestamp: 1,
      role: "user",
      content: [
        { type: "text", text: "查一下天气" },
        { type: "image", image: "raw-image" },
      ],
    },
    {
      id: "assistant",
      timestamp: 2,
      role: "assistant",
      content: [
        { type: "reasoning", text: "PRIVATE_REASONING" },
        { type: "tool-call", toolCallId: "call-1", toolName: "web_search", input: { query: "PRIVATE_QUERY", inner_thought: "PRIVATE_THOUGHT" } },
      ],
    },
    {
      id: "tool",
      timestamp: 3,
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "web_search",
          output: {
            provider: "test",
            query: "天气",
            results: [{ title: "天气预报", url: "https://example.com/weather", snippet: "今天晴。", rawContent: "今天晴，PRIVATE_RESULT" }],
            inner_thought: "PRIVATE_OUTPUT_THOUGHT",
            reason: "PRIVATE_OUTPUT_REASON",
          },
        },
        { type: "tool-result", toolCallId: "call-2", toolName: "send_message", output: { messages: ["已经发送"] } },
        { type: "tool-result", toolCallId: "call-3", toolName: "generate_image", output: { artifact: "artifact://image/1", image: "raw-pixels" } },
      ],
    },
  ] as unknown as AgentMessage[];
}

describe("extractProtectedTokens", () => {
  it("extracts numeric expressions, element tags, resource URIs, and at mentions", () => {
    expect(extractProtectedTokens('看 -12.5%、+3/4 和 asset://abc123<img src="asset://up"/> <at id="7"/> @bob @bob.example @猫-龙')).toEqual([
      "-12.5%",
      "+3/4",
      "asset://abc123",
      '<img src="asset://up"/>',
      '<at id="7"/>',
      "@bob",
      "@bob.example",
      "@猫-龙",
    ]);
  });
});

describe("buildPolisherTurnContext", () => {
  it("keeps current user/media and safe tool results while excluding reasoning, calls, sends, and image output", () => {
    const context = buildPolisherTurnContext(currentTurnMessages());
    expect(context).toEqual([
      { kind: "user", content: "查一下天气[图片]" },
      {
        kind: "tool-result",
        toolName: "web_search",
        content: expect.stringContaining('"query": "天气"'),
      },
    ]);

    const serialized = JSON.stringify(context);
    expect(serialized).toContain("天气预报");
    expect(serialized).toContain("PRIVATE_RESULT");
    expect(serialized).not.toContain("PRIVATE_REASONING");
    expect(serialized).not.toContain("PRIVATE_QUERY");
    expect(serialized).not.toContain("PRIVATE_THOUGHT");
    expect(serialized).not.toContain("PRIVATE_OUTPUT_THOUGHT");
    expect(serialized).not.toContain("send_message");
    expect(serialized).not.toContain("generate_image");
    expect(serialized).not.toContain("raw-pixels");
  });

  it("bounds each entry and the complete current-turn reference", () => {
    const messages = [
      { id: "user", timestamp: 1, role: "user", content: [{ type: "text", text: "x".repeat(100_000) }] },
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `tool-${index}`,
        timestamp: index + 2,
        role: "tool",
        content: [{ type: "tool-result", toolName: "lookup", output: { text: "y".repeat(10_000) } }],
      })),
    ] as unknown as AgentMessage[];

    const context = buildPolisherTurnContext(messages);
    expect(context.length).toBeLessThanOrEqual(16);
    expect(context.every((entry) => entry.content.length <= 4_000)).toBe(true);
    expect(context.reduce((total, entry) => total + entry.content.length, 0)).toBeLessThanOrEqual(16_000);
  });
});

describe("validatePolishedMessages", () => {
  it("accepts a same-length rewrite that preserves protected tokens", () => {
    expect(validatePolishedMessages(['<at id="123"/> 你好，asset://abc123'], ['<at id="123"/> 你好呀，asset://abc123'])).toEqual([
      '<at id="123"/> 你好呀，asset://abc123',
    ]);
  });

  it("preserves unchanged tokens in each message, including repeated numbers, tags and URIs", () => {
    const draft = ['@a <at id="7"/> asset://abc 12 12', "@b artifact://tool/xyz"];
    expect(validatePolishedMessages(draft, [...draft])).toEqual(draft);
  });

  const protectedCases: Array<[string[], unknown]> = [
    [["原稿 123"], ["原稿 456"]],
    [["余额 -12 元"], ["余额 12 元"]],
    [["价格 1.2 元"], ["价格 1,2 元"]],
    [["进度 100%"], ["进度 100"]],
    [["比例 1/2"], ["比例 1,2"]],
    [['<at id="123"/> 原稿'], ['<at id="999"/> 原稿']],
    [["asset://abc123 原稿"], ["asset://def456 原稿"]],
    [["原稿 123"], ["原稿"]],
    [["@a @b"], ["@b @a"]],
    [["@bob.example"], ["@bob.other"]],
    [["12 和 34"], ["34 和 12"]],
    [["asset://abc 与 artifact://tool/xyz"], ["artifact://tool/xyz 与 asset://abc"]],
    [['<at id="7"/> @a'], ['@a <at id="7"/>']],
    [["@a @a"], ["@a @b"]],
    [["asset://abc asset://abc"], ["asset://abc asset://def"]],
    [["原稿"], ["原稿", "多余"]],
    [["原稿"], [""]],
    [["原稿"], ["   "]],
    [["原稿"], [42]],
    [["原稿"], "原稿"],
  ];

  it.each(protectedCases)("rejects a rewrite that changes protected tokens or shape (%j)", (original, candidate) => {
    expect(validatePolishedMessages(original, candidate)).toBeUndefined();
  });

  it("rejects an empty draft", () => {
    expect(validatePolishedMessages([], [])).toBeUndefined();
  });
});

describe("PolisherRegistry", () => {
  it("activates on registration and tracks disposal independently of the auxiliary route", async () => {
    const registry = new PolisherRegistry();
    const unavailable = { name: "unavailable", polish: vi.fn(async () => undefined) };
    const available = { name: "available", polish: vi.fn(async () => ["polished"]) };

    expect(registry.revision).toBe(0);
    const disposeUnavailable = registry.use(unavailable);
    const disposeAvailable = registry.use(available);
    expect(registry.revision).toBe(2);

    expect(registry.resolve()).toBe(unavailable);
    disposeUnavailable();
    expect(registry.resolve()).toBe(available);
    disposeAvailable();
    expect(registry.resolve()).toBeUndefined();
    expect(registry.revision).toBe(4);
  });

  it("notifies listeners for capability and profile revisions", () => {
    const registry = new PolisherRegistry();
    const revisions: number[] = [];
    const disposeListener = registry.onRevision((revision) => revisions.push(revision));
    const capability = { name: "capability", polish: vi.fn(async () => undefined) };
    const provider = { name: "provider", resolve: () => undefined };

    const disposeCapability = registry.use(capability);
    const disposeProvider = registry.profile(provider);
    disposeCapability();
    disposeProvider();

    expect(revisions).toEqual([1, 2, 3, 4]);
    disposeListener();
    registry.use(capability);
    expect(revisions).toEqual([1, 2, 3, 4]);
  });

  it("uses only a non-empty role profile and swallows provider failures", async () => {
    const registry = new PolisherRegistry();
    const empty = { name: "empty", resolve: () => undefined };
    const broken = {
      name: "broken",
      resolve: () => {
        throw new Error("boom");
      },
    };
    const real = { name: "real", resolve: () => ({ roleInstructions: "stay in character" }) };
    registry.profile(empty);
    registry.profile(broken);
    registry.profile(real);

    await expect(registry.resolveProfile(context)).resolves.toEqual({ roleInstructions: "stay in character" });
  });
});

describe("createSendMessageTool polisher integration", () => {
  it("keeps the baseline schema and sends the draft unchanged without a polish hook", async () => {
    const { tool, sendMessage } = createTool();
    expect((tool.inputSchema as { jsonSchema: { required?: string[] } }).jsonSchema.required).toEqual(["messages"]);

    await tool.execute({ messages: ["原稿"], mode: "raw" }, execution());

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sentPayload(sendMessage)).toContain("原稿");
  });

  it("requires facts and replaces only messages with the validated polish", async () => {
    const polish = vi.fn(async () => ["润色后的稿子"]);
    const { tool, sendMessage } = createTool({ polish: createPolishHook(polish) });
    expect((tool.inputSchema as { jsonSchema: { required?: string[] } }).jsonSchema.required).toEqual(["facts", "messages"]);

    const result = await tool.execute({ facts: ["可确认的事实"], messages: ["原稿"], channel: "other", mode: "raw", continue: false }, execution());

    expect(result).toMatchObject({ ok: true });
    expect(polish).toHaveBeenCalledWith(expect.objectContaining({ facts: ["可确认的事实"], messages: ["原稿"] }), context, undefined);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0]).toBe("other");
    expect(sentPayload(sendMessage)).toContain("润色后的稿子");
    expect(sentPayload(sendMessage)).not.toContain("原稿");
  });

  it("keeps blank lines inside the accepted polish while preserving the draft shape and receipt count", async () => {
    const polish = vi.fn(async () => ["润色一\n\n润色二"]);
    const { tool, sendMessage } = createTool({ polish: createPolishHook(polish) });
    const input = { facts: ["f"], messages: ["草稿一\n\n草稿二"], mode: "raw" as const };

    await expect(tool.execute(input, execution())).resolves.toMatchObject({ ok: true, count: 1, messageIds: ["m1"] });
    expect(polish).toHaveBeenCalledOnce();
    expect(polish).toHaveBeenCalledWith(expect.objectContaining({ messages: ["草稿一\n\n草稿二"] }), context, undefined);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sentPayload(sendMessage)).toContain("润色一");
    expect(sentPayload(sendMessage)).toContain("润色二");
    expect(input.messages).toEqual(["草稿一\n\n草稿二"]);
  });

  it("keeps the original draft as one delivery when polishing fails", async () => {
    const polish = vi.fn(async () => {
      throw new Error("unavailable");
    });
    const { tool, sendMessage } = createTool({ polish });

    await expect(tool.execute({ facts: ["f"], messages: ["草稿一\n\n草稿二"], mode: "raw" }, execution())).resolves.toMatchObject({ ok: true, count: 1 });
    expect(polish).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sentPayload(sendMessage)).toContain("草稿一");
    expect(sentPayload(sendMessage)).toContain("草稿二");
  });

  it("forwards the bounded current-turn context immediately before polishing", async () => {
    const polish = vi.fn(async () => ["润色后的稿子"]);
    const { tool, sendMessage } = createTool({ polish: createPolishHook(polish) });

    await tool.execute({ facts: ["天气结果"], messages: ["原稿"], mode: "raw" }, execution(currentTurnMessages()));

    expect(polish).toHaveBeenCalledWith(
      expect.objectContaining({
        facts: ["天气结果"],
        messages: ["原稿"],
        turnContext: expect.arrayContaining([expect.objectContaining({ kind: "tool-result", toolName: "web_search" })]),
      }),
      context,
      undefined,
    );
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("preserves the sender's partial-failure receipt after polishing without retrying delivery", async () => {
    const sendMessage = vi.fn().mockResolvedValueOnce(["m1"]).mockRejectedValueOnce(new Error("offline"));
    const { tool } = createTool({ sendMessage, polish: async () => ["润色一", "润色二"] });

    await expect(tool.execute({ facts: ["f"], messages: ["草稿一", "草稿二"], mode: "raw" }, execution())).resolves.toEqual({
      ok: false,
      error: { name: "Error", message: "offline" },
      sent: ["m1"],
      failedAt: 1,
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sentPayload(sendMessage, 0)).toContain("润色一");
    expect(sentPayload(sendMessage, 1)).toContain("润色二");
  });

  it("falls back to the original draft when the polish changes protected tokens", async () => {
    const polish = vi.fn(async () => ["换了说法 999"]);
    const { tool, sendMessage } = createTool({ polish: createPolishHook(polish) });

    await tool.execute({ facts: ["f"], messages: ["原稿 123"], mode: "raw" }, execution());

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sentPayload(sendMessage)).toContain("原稿 123");
    expect(sentPayload(sendMessage)).not.toContain("999");
  });

  it.each([
    ["changes protected token order", ["@b @a"]],
    ["returns the wrong number of messages", ["@a @b", "extra"]],
    ["returns an empty message", [""]],
  ])("rejects a raw polish callback that %s at the send boundary", async (_reason, result) => {
    const { tool, sendMessage } = createTool({ polish: async () => result });
    await tool.execute({ facts: ["f"], messages: ["@a @b"], mode: "raw" }, execution());
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sentPayload(sendMessage)).toContain("@a @b");
  });

  it("does not call a polisher after its capability is unregistered", async () => {
    const registry = new PolisherRegistry();
    const capability = { name: "test", polish: vi.fn(async () => ["不要发送"] as const) };
    const dispose = registry.use(capability);
    const polish = createSendMessagePolisher({ registry, resolveProfile: async () => ({ persona: "p" }), context });
    const { tool, sendMessage } = createTool({ polish });

    dispose();
    await tool.execute({ facts: ["f"], messages: ["原稿"], mode: "raw" }, execution());

    expect(capability.polish).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sentPayload(sendMessage)).toContain("原稿");
    expect(sentPayload(sendMessage)).not.toContain("不要发送");
  });

  it("falls back if the capability is unregistered during polishing", async () => {
    const registry = new PolisherRegistry();
    let dispose!: () => void;
    const capability = {
      name: "test",
      polish: vi.fn(async () => {
        dispose();
        return ["不要发送"];
      }),
    };
    dispose = registry.use(capability);
    const polish = createSendMessagePolisher({ registry, resolveProfile: async () => ({ persona: "p" }), context });
    const { tool, sendMessage } = createTool({ polish });

    await tool.execute({ facts: ["f"], messages: ["原稿"], mode: "raw" }, execution());

    expect(capability.polish).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sentPayload(sendMessage)).toContain("原稿");
    expect(sentPayload(sendMessage)).not.toContain("不要发送");
  });

  it("resolves the live persona profile for each polishing call", async () => {
    const registry = new PolisherRegistry();
    const capability: MessagePolisherCapability = {
      name: "test",
      polish: vi.fn(async ({ profile }) => [profile.persona]),
    };
    registry.use(capability);
    let version = 0;
    const resolveProfile = vi.fn(async () => ({ persona: `persona-${++version}` }));
    const polish = createSendMessagePolisher({ registry, resolveProfile, context });

    await expect(polish({ facts: ["f"], messages: ["draft"], turnContext: [] })).resolves.toEqual(["persona-1"]);
    await expect(polish({ facts: ["f"], messages: ["draft"], turnContext: [] })).resolves.toEqual(["persona-2"]);
    expect(resolveProfile).toHaveBeenCalledTimes(2);
    expect(capability.polish).toHaveBeenNthCalledWith(
      1,
      { facts: ["f"], messages: ["draft"], profile: { persona: "persona-1" }, turnContext: [] },
      context,
      undefined,
    );
  });

  it("falls back to the original draft when the polisher throws", async () => {
    const { tool, sendMessage } = createTool({
      polish: async () => {
        throw new Error("polisher down");
      },
    });

    await expect(tool.execute({ facts: ["f"], messages: ["原稿"], mode: "raw" }, execution())).resolves.toMatchObject({ ok: true });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sentPayload(sendMessage)).toContain("原稿");
  });
});
