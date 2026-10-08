import { createAgent, createUserMessage } from "@yesimbot/agent-runtime";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import type { Bot } from "koishi";
import { describe, expect, it, vi } from "vitest";
vi.mock("koishi", async () => import("@koishijs/core"));

import { BotStickerSender } from "../../plugins/sticker-manager/src/sender.js";
import { createDeps, scope, stickerId, pngBytes } from "../../plugins/sticker-manager/tests/preview-fixtures.js";
import { createSendMessageTool, createFinishTool } from "../src/agents/tools.js";

type Call = { toolName: string; input: Record<string, unknown> };
const preview: Call = { toolName: "sticker_preview", input: { sticker_id: stickerId } };
const sticker = (continued = false): Call => ({ toolName: "sticker_send", input: { sticker_id: stickerId, continue: continued } });
const text = (continued = false, messages = ["hello"]): Call => ({ toolName: "send_message", input: { messages, mode: "raw", continue: continued } });
const finish: Call = { toolName: "finish", input: {} };

function scriptedModel(steps: readonly (Call | Call[])[]) {
  let index = 0;
  return new MockLanguageModelV3({
    doStream: () => {
      const step = steps[index];
      if (!step) throw new Error("unexpected model step");
      const stepId = index++;
      const calls = Array.isArray(step) ? step : [step];
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          ...calls.flatMap((call, i) => {
            const id = `call-${stepId}-${i}`;
            const input = JSON.stringify(call.input);
            return [
              { type: "tool-input-start" as const, id, toolName: call.toolName },
              { type: "tool-input-delta" as const, id, delta: input },
              { type: "tool-input-end" as const, id },
              { type: "tool-call" as const, toolCallId: id, toolName: call.toolName, input },
            ];
          }),
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          },
        ]),
      };
    },
  });
}

async function run(steps: readonly (Call | Call[])[], mode: "native" | "vision" | "unavailable" = "native", polish = false) {
  const deps = createDeps({}, mode);
  const sendMessage = vi.fn(async (_channel: string, _elements: unknown) => ["message-id"]);
  const bot = { platform: "test", sendMessage } as unknown as Bot;
  const sender = new BotStickerSender(bot, scope);
  deps.sender.send.mockImplementation(sender.send.bind(sender) as never);
  const textTool = createSendMessageTool({
    bot,
    channelId: scope.channelId,
    resources: {} as never,
    pacing: { charactersPerSecond: 1000, maxTotalDelayMs: 60_000 },
    innerThought: false,
    ...(polish ? { factsRequired: true, polish: async ({ messages }) => [...messages] } : {}),
  });
  const withFacts = (call: Call): Call =>
    polish && call.toolName === "send_message" ? { ...call, input: { ...call.input, facts: ["当前消息需要确认和补充"] } } : call;
  const model = scriptedModel(steps.map((step) => (Array.isArray(step) ? step.map(withFacts) : withFacts(step))));
  const agent = createAgent({ model, tools: [textTool, deps.preview, ...deps.tools, createFinishTool()], requireTerminalTool: true });
  const events: string[] = [];
  try {
    for await (const event of agent.run(createUserMessage("hello"))) events.push(event.type);
    await agent.wait();
    return {
      model,
      events,
      kinds: sendMessage.mock.calls.map(([, elements]) => (elements as { type: string }[]).map((item) => item.type)),
      entries: await agent.storage.read(),
      sendMessage,
      deps,
      textTool,
    };
  } finally {
    await agent.stop();
    deps.projection.clearAll();
    deps.gate.clear();
    deps.slot.clear();
  }
}

describe("Core and Sticker viewed delivery", () => {
  it.each([
    { name: "sticker only", steps: [preview, sticker()], expected: [["img"]] },
    { name: "text only", steps: [text()], expected: [["text"]] },
    { name: "sticker then text", steps: [preview, sticker(true), text()], expected: [["img"], ["text"]] },
    { name: "text then sticker", steps: [preview, text(true), sticker()], expected: [["text"], ["img"]] },
    { name: "text sticker text", steps: [preview, text(true), sticker(true), text()], expected: [["text"], ["img"], ["text"]] },
  ])("supports $name without inserting other output", async ({ steps, expected }) => {
    const result = await run(steps);
    expect(result.events).toContain("turn.done");
    expect(result.events).not.toContain("turn.failed");
    expect(result.kinds).toEqual(expected);
    expect(result.model.doStreamCalls).toHaveLength(steps.length);
    expect(JSON.stringify(result.entries)).not.toContain(Buffer.from(pngBytes).toString("base64"));
    if (expected.some((parts) => parts.includes("img"))) expect(result.deps.store.markUsed).toHaveBeenCalledOnce();
  });

  it("puts actual native preview bytes in the next request, but not durable history", async () => {
    const result = await run([preview, sticker()]);
    expect(JSON.stringify(result.model.doStreamCalls[1])).toContain('"type":"image-data"');
    expect(JSON.stringify(result.model.doStreamCalls[1])).toContain(Buffer.from(pngBytes).toString("base64"));
    expect(result.kinds).toEqual([["img"]]);
    expect(JSON.stringify(result.entries)).not.toContain('"type":"image-data"');
  });

  it("uses delegated vision evidence without native image output", async () => {
    const result = await run([preview, sticker()], "vision");
    expect(result.kinds).toEqual([["img"]]);
    expect(result.deps.capability.describe).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.model.doStreamCalls[1])).toContain("红色与蓝色");
  });

  it("cannot authorize a same-step send even if preview executes first", async () => {
    const result = await run([[preview, sticker()], finish]);
    expect(result.kinds).toEqual([]);
    expect(JSON.stringify(result.entries)).toContain("sticker_preview_required");
  });

  it("rejects an unread sticker without delivery", async () => {
    const result = await run([sticker()]);
    expect(result.kinds).toEqual([]);
    expect(result.deps.sender.send).not.toHaveBeenCalled();
  });

  it("allows text fallback after unavailable preview", async () => {
    const result = await run([preview, text()], "unavailable");
    expect(result.kinds).toEqual([["text"]]);
    expect(result.deps.store.markUsed).not.toHaveBeenCalled();
  });

  it("blocks two same-step send calls after a legitimate preview", async () => {
    const result = await run([preview, [sticker(), sticker()]]);
    expect(result.kinds).toEqual([["img"]]);
    expect(result.deps.store.markUsed).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.entries)).toContain("sticker_send_limit_reached");
  });

  it.each([false, true])("delivers semantic array boundaries with polisher=%s without continuation", async (polish) => {
    const result = await run([text(false, ["收到", "另一个补充"])], "native", polish);
    expect(result.kinds).toEqual([["text"], ["text"]]);
    expect(JSON.stringify(result.sendMessage.mock.calls[0])).toContain("收到");
    expect(JSON.stringify(result.sendMessage.mock.calls[1])).toContain("另一个补充");
    expect(result.model.doStreamCalls).toHaveLength(1);
    expect(result.textTool.description).toContain("按语义和聊天节奏");
    expect(result.textTool.description).toContain("不需要仅为分条设置 continue=true");
  });
});
