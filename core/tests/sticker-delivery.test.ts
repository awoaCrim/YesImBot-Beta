import { createAgent, createUserMessage } from "@yesimbot/agent-runtime";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import type { Bot } from "koishi";
import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { BotStickerSender } from "../../plugins/sticker-manager/src/sender.js";
import type { StickerStore } from "../../plugins/sticker-manager/src/store.js";
import { createStickerTools } from "../../plugins/sticker-manager/src/tools.js";
import type { StickerConfig, StickerProjection } from "../../plugins/sticker-manager/src/types.js";
import { createSendMessageTool } from "../src/agents/tools.js";
import type { ChannelContext } from "../src/channels/index.js";

const scope: ChannelContext = { type: "guild", platform: "test", channelId: "room", guildId: "room" };
const config: StickerConfig = {
  scope: "global",
  storagePath: "unused",
  classificationModel: "",
  classificationPrompt: "",
  maxImportFileBytes: 1024 * 1024,
  tagMode: false,
  fuzzyTagMatch: true,
  tagRandomRange: 1,
  sendStaticAsGif: false,
  stickerElement: true,
  enableSteal: false,
};

type ScriptedCall = { toolName: string; input: Record<string, unknown> };

function scriptedModel(calls: readonly ScriptedCall[]) {
  let streamIndex = 0;
  const streams = calls.map((call, index) => ({
    stream: convertArrayToReadableStream([
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: `call-${index}`, toolName: call.toolName },
      { type: "tool-input-delta", id: `call-${index}`, delta: JSON.stringify(call.input) },
      { type: "tool-input-end", id: `call-${index}` },
      { type: "tool-call", toolCallId: `call-${index}`, toolName: call.toolName, input: JSON.stringify(call.input) },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      },
    ]),
  }));
  return new MockLanguageModelV3({ doStream: () => streams[streamIndex++]! });
}

function deliveryTools() {
  const sendMessage = vi.fn(async (_channel: string, _elements: unknown) => ["message-id"]);
  const bot = { platform: "test", sendMessage } as unknown as Bot;
  const textTool = createSendMessageTool({
    bot,
    channelId: scope.channelId,
    resources: {} as never,
    pacing: { charactersPerSecond: 1000, maxTotalDelayMs: 60_000 },
    innerThought: false,
  });
  const sticker: StickerProjection = {
    id: "a".repeat(64),
    category: "开心",
    tags: [],
    mime: "image/png",
    size: 4,
    source: { kind: "import" },
    usageCount: 0,
    lastUsedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const store = {
    random: vi.fn(async () => sticker),
    readBytes: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    markUsed: vi.fn(async () => ({ ...sticker, usageCount: 1 })),
  };
  const stickers = createStickerTools({
    store: store as unknown as StickerStore,
    classifier: { classify: vi.fn() },
    sender: new BotStickerSender(bot, scope),
    assets: {} as never,
    scope,
    config,
    sentTurnIds: new Set<string>(),
  });
  return { sendMessage, store, textTool, tools: [textTool, ...stickers] };
}

async function run(calls: readonly ScriptedCall[], deps: ReturnType<typeof deliveryTools>) {
  const model = scriptedModel(calls);
  const agent = createAgent({ model, tools: deps.tools, requireTerminalTool: true });
  const events: string[] = [];
  try {
    for await (const event of agent.run(createUserMessage("hello"))) events.push(event.type);
    await agent.wait();
    return { model, events };
  } finally {
    await agent.stop();
  }
}

function sentKinds(send: ReturnType<typeof deliveryTools>["sendMessage"]) {
  return send.mock.calls.map(([, elements]) => (elements as { type: string }[]).map((element) => element.type));
}

describe("Core and Sticker terminal delivery", () => {
  it("keeps send_message guidance compatible with plugin delivery and explicit continuation", () => {
    const { textTool } = deliveryTools();
    expect(textTool.description).not.toContain("唯一途径");
    expect(textTool.description).toContain("其他实际提供的发送工具");
    expect(textTool.description).toContain("默认 false，发送后结束本轮");
    expect(textTool.description).toContain("必须在这次发送前设为 true");
    expect(textTool.description).not.toContain("sticker_send");
    expect(JSON.stringify(textTool.inputSchema)).toContain("默认 false，发送后结束本轮");
  });

  it("sends text first and one sticker next, then ends without another generation", async () => {
    const deps = deliveryTools();
    const { model, events } = await run(
      [
        { toolName: "send_message", input: { messages: ["好耶"], mode: "raw", continue: true } },
        { toolName: "sticker_send", input: { category: "开心" } },
        { toolName: "send_message", input: { messages: ["must not be sent"], mode: "raw" } },
      ],
      deps,
    );

    expect(events).toContain("turn.done");
    expect(events).not.toContain("turn.failed");
    expect(model.doStreamCalls).toHaveLength(2);
    expect(sentKinds(deps.sendMessage)).toEqual([["text"], ["img"]]);
    expect(deps.store.random).toHaveBeenCalledWith("global", "开心");
    expect(deps.store.markUsed).toHaveBeenCalledOnce();
  });

  it("allows a sticker-only reply and prevents text after its terminal call", async () => {
    const deps = deliveryTools();
    const { model, events } = await run(
      [
        { toolName: "sticker_send", input: {} },
        { toolName: "send_message", input: { messages: ["must not be sent"], mode: "raw" } },
      ],
      deps,
    );

    expect(events).toContain("turn.done");
    expect(events).not.toContain("turn.failed");
    expect(model.doStreamCalls).toHaveLength(1);
    expect(sentKinds(deps.sendMessage)).toEqual([["img"]]);
    expect(deps.store.markUsed).toHaveBeenCalledOnce();
  });

  it.each([undefined, false])("keeps text-only delivery terminal when continue is %s", async (continuation) => {
    const deps = deliveryTools();
    const { model, events } = await run(
      [
        { toolName: "send_message", input: { messages: ["just text"], mode: "raw", ...(continuation === undefined ? {} : { continue: continuation }) } },
        { toolName: "sticker_send", input: {} },
      ],
      deps,
    );

    expect(events).toContain("turn.done");
    expect(events).not.toContain("turn.failed");
    expect(model.doStreamCalls).toHaveLength(1);
    expect(sentKinds(deps.sendMessage)).toEqual([["text"]]);
    expect(deps.store.random).not.toHaveBeenCalled();
    expect(deps.store.markUsed).not.toHaveBeenCalled();
  });
});
